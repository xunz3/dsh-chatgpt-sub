import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { resolveSearchMode, type SearchConfig } from '../../src/shared/search.js'

// These tests share the host's search configuration and navigation state.
test.describe.configure({ mode: 'serial' })

interface NamespaceView { ns: string; value: SearchConfig; user: SearchConfig; revision: number }

async function settings<T>(page: Page, method: 'describe' | 'mutate', args: Record<string, unknown>): Promise<T> {
  // Use the browser context's signed host cookie without relying on page navigation
  // or exposing the startup token. These are the same owner-checked settings RPCs.
  const response = await page.request.post(new URL(`api/settings/${method}`, page.url()).href, {
    timeout: 15_000,
    data: { type: 'client-request', rpcId: crypto.randomUUID(), method: `settings/${method}`, payload: { args } },
  })
  if (!response.ok()) throw new Error(`The host rejected the settings request (HTTP ${response.status()})`)
  const envelope = await response.json()
  if (!envelope.result?.ok) throw new Error('The host rejected the settings operation')
  return envelope.result.value
}

async function view(page: Page) {
  const result = await settings<{ namespaces: NamespaceView[] }>(page, 'describe', {})
  const plugin = result.namespaces.find(namespace => namespace.ns === 'chatgpt-sub')
  if (!plugin) throw new Error('The installed host has no ChatGPT settings namespace')
  return plugin
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'ChatGPT', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Web search', exact: true })).toBeEnabled()
}

async function openHost(page: Page) {
  let url: string | undefined
  await expect.poll(async () => {
    const log = await readFile(process.env.DSH_WEB_LOG!, 'utf8').catch(() => '')
    url = log.match(/dsh web: (http[^\s]+)/)?.[1]
    return !!url
  }, { timeout: 15_000, message: 'Wait for the isolated DSH Web startup' }).toBe(true)
  await page.addInitScript(() => localStorage.setItem('dsh-chatgpt-sub:welcome', '1'))
  await page.goto(url!, { waitUntil: 'networkidle' })
}

async function restoreMode(page: Page, before: NamespaceView) {
  const current = await view(page)
  const op = before.user.searchMode === undefined
    ? { op: 'unset', path: ['searchMode'] }
    : { op: 'set', path: ['searchMode'], value: before.user.searchMode }
  const restored = await settings<NamespaceView>(page, 'mutate', { ns: 'chatgpt-sub', ops: [op], expectedRevision: current.revision })
  expect(restored.user).toEqual(before.user)
}

// Explicit opt-in: writes only searchMode on an isolated English host, then
// restores the original field through the same revision-checked settings API.
test('installed settings persist explicit search modes and preserve the old configuration', async ({ page }, info) => {
  test.skip(process.env.DSH_SEARCH_SETTINGS_TEST !== '1' || !process.env.DSH_WEB_LOG, 'Enable reversible live settings tests explicitly')
  test.setTimeout(60_000)
  await openHost(page)
  const before = await view(page)
  await openSettings(page)
  const select = page.getByRole('combobox', { name: 'Web search', exact: true })
  await expect(select.locator('option')).toHaveCount(3)
  await expect(select).toHaveValue(resolveSearchMode(before.value))
  try {
    for (const mode of ['harness', 'off', 'native'] as const) {
      await select.selectOption(mode)
      await expect.poll(async () => (await view(page)).value.searchMode).toBe(mode)
      const current = await view(page)
      expect(current.user).toEqual({ ...before.user, searchMode: mode })
      await page.reload({ waitUntil: 'networkidle' })
      await openSettings(page)
      await expect(select).toHaveValue(mode)
    }
    await expect(page.getByText('GPT can use OpenAI search outside Harness tool approvals and URL rules.')).toBeVisible()
    await page.screenshot({ path: info.outputPath('search-settings.png'), fullPage: true, mask: [page.locator('.cgs-current')], maskColor: '#e5e7eb' })
  } finally {
    await restoreMode(page, before)
  }
})

// Uses an existing disposable test session with a completed native search.
// Makes one plan-backed request; never enable this against a user's conversation.
test('an existing native search conversation continues with search turned off', async ({ page }, info) => {
  test.skip(process.env.DSH_SEARCH_HISTORY_TEST !== '1' || !process.env.DSH_WEB_LOG || !process.env.DSH_SEARCH_HISTORY_TITLE, 'Opt in with a disposable native-search session title')
  test.setTimeout(120_000)
  await openHost(page)
  await page.getByRole('treeitem').filter({ hasText: process.env.DSH_SEARCH_HISTORY_TITLE! }).first().click()
  const source = page.locator('a[href^="https://developers.openai.com/"], a[href^="https://platform.openai.com/"]').first()
  await expect(source).toBeVisible()
  const domain = new URL((await source.getAttribute('href'))!).hostname
  const before = await view(page)
  try {
    await settings(page, 'mutate', { ns: 'chatgpt-sub', ops: [{ op: 'set', path: ['searchMode'], value: 'off' }], expectedRevision: before.revision })
    const marker = `history-${randomBytes(4).toString('hex')}`
    await page.locator('[contenteditable=true][role=textbox]').fill(`Without searching or using any tools, read the official source link in your preceding answer. Reply only with "${marker}: " followed by that source's hostname.`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText(`${marker}: ${domain}`, { exact: true })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('search-history-off.png'), fullPage: true })
  } finally {
    await restoreMode(page, before)
  }
})

// Creates a disposable conversation and consumes two plan-backed requests.
test('native search returns citations and continues after switching off', async ({ page }, info) => {
  test.skip(process.env.DSH_NATIVE_SEARCH_TEST !== '1' || !process.env.DSH_WEB_LOG, 'Enable live native search tests explicitly')
  test.setTimeout(180_000)
  await openHost(page)
  const before = await view(page)
  try {
    await settings(page, 'mutate', { ns: 'chatgpt-sub', ops: [{ op: 'set', path: ['searchMode'], value: 'native' }], expectedRevision: before.revision })
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const modelPicker = page.getByRole('button', { name: /^Select model/ })
    await expect(modelPicker).toBeVisible({ timeout: 45_000 })
    await modelPicker.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('group', { name: 'ChatGPT plan', exact: true }).getByRole('menuitemradio', { name: process.env.DSH_SEARCH_MODEL ?? 'GPT-6.1-Sol', exact: true }).click()
    await expect(modelPicker.locator('[data-provider-id="chatgpt-sub"]')).toBeVisible()
    const marker = `native-${randomBytes(4).toString('hex')}`
    const composer = page.locator('[contenteditable=true][role=textbox]')
    await composer.fill(`Use your built-in OpenAI web_search to search the official OpenAI documentation for the page named Web search. Explain in one short sentence how Responses enables it and include a clickable source citation. Do not use Harness tools, files or shell commands. Test reference: ${marker}.`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const source = page.locator('a[href^="https://developers.openai.com/"], a[href^="https://platform.openai.com/"]').first()
    await expect(source).toBeVisible({ timeout: 120_000 })
    await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0, { timeout: 30_000 })
    const domain = new URL((await source.getAttribute('href'))!).hostname
    await info.attach('search-reference', { body: marker, contentType: 'text/plain' })
    // Hosted search uses Harness's existing process/reasoning disclosures.
    const turn = page.locator('button[data-turn-process][aria-expanded="false"]').last()
    if (await turn.count()) await turn.click()
    for (const step of await page.locator('button[data-process-activity][aria-expanded="false"]').all()) await step.click()
    await expect(page.locator('[data-variant="think"]:visible').first()).toBeVisible()
    for (const row of await page.locator('[data-variant="think"]:visible').all()) {
      const toggle = row.getByRole('button', { expanded: false }).first()
      if (await toggle.count()) await toggle.click()
    }
    const searchProgress = page.locator('[data-variant="think"]:visible').filter({ hasText: 'Web search completed.' }).first()
    await expect(searchProgress).toBeVisible()
    await expect(searchProgress).toContainText(/Search: “.+”/)
    await page.screenshot({ path: info.outputPath('native-search-progress.png'), fullPage: true })
    const current = await view(page)
    await settings(page, 'mutate', { ns: 'chatgpt-sub', ops: [{ op: 'set', path: ['searchMode'], value: 'off' }], expectedRevision: current.revision })
    await composer.fill(`Without searching or using any tools, read the official source link in your preceding answer. Reply only with "${marker}: " followed by that source's hostname.`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(page.getByText(`${marker}: ${domain}`, { exact: true })).toBeVisible({ timeout: 90_000 })
    await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0, { timeout: 30_000 })
    await expect(source).toBeVisible()
    await page.screenshot({ path: info.outputPath('native-search-continued.png'), fullPage: true })
  } finally {
    await restoreMode(page, before)
  }
})

// Reproduces the loss of hosted search excerpts across a real Harness tool step.
// The selected workspace must belong to this disposable local test host.
test('native search evidence survives a local read checkpoint in the installed host', async ({ page }, info) => {
  test.skip(process.env.DSH_SEARCH_CHECKPOINT_TEST !== '1' || !process.env.DSH_WEB_LOG || !process.env.DSH_SEARCH_WORKSPACE, 'Opt in with a disposable signed-in host and its workspace')
  test.setTimeout(180_000)
  page.setDefaultTimeout(30_000)
  const marker = `search-checkpoint-${randomBytes(4).toString('hex')}`
  const fixture = join(process.env.DSH_SEARCH_WORKSPACE!, `${marker}.txt`)
  await writeFile(fixture, 'CHECKPOINT_OK\n', { flag: 'wx', mode: 0o600 })
  let before: NamespaceView | undefined
  try {
    await openHost(page)
    before = await view(page)
    await settings(page, 'mutate', { ns: 'chatgpt-sub', ops: [{ op: 'set', path: ['searchMode'], value: 'native' }], expectedRevision: before.revision })
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const modelPicker = page.getByRole('button', { name: /^Select model/ })
    await expect(modelPicker).toBeVisible({ timeout: 45_000 })
    await modelPicker.click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    const model = page.getByRole('group', { name: 'ChatGPT plan', exact: true }).getByRole('menuitemradio', { name: process.env.DSH_SEARCH_MODEL ?? 'GPT-6.1-Sol', exact: true })
    const retryCatalog = page.getByRole('button', { name: 'Retry', exact: true })
    await expect.poll(async () => await model.count() > 0 || await retryCatalog.count() > 0, { timeout: 45_000 }).toBe(true)
    if (await retryCatalog.count()) await retryCatalog.click()
    await model.click({ timeout: 45_000 })
    await page.locator('[contenteditable=true][role=textbox]').fill(`Use OpenAI built-in web_search once for this exact query: deepseek harness dsh plugin development github. Immediately afterward call harness.read on ${JSON.stringify(fixture)}, without writing an answer or summary first. The file is only a checkpoint and contains no web information. After read returns, report three different source URLs actually found in that completed search, each as a Markdown link with a short exact quotation from its retained excerpt. Do not search again, use other tools, or invent sources. If the excerpts are unavailable, say NO_RETAINED_RESULTS. Start the final answer with ${marker}. Keep it under 200 words.`)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const links = page.locator('a[href^="https://"]')
    await expect.poll(async () => new Set(await links.evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href))).size, { timeout: 120_000 }).toBeGreaterThanOrEqual(3)
    await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0, { timeout: 30_000 })
    const turn = page.locator('button[data-turn-process][aria-expanded="false"]').last()
    if (await turn.count()) await turn.click()
    for (const step of await page.locator('button[data-process-activity][aria-expanded="false"]').all()) await step.click()
    const evidence = page.locator('[data-variant="think"]').filter({ hasText: 'Web search sources' }).first()
    await expect(evidence).toBeVisible()
    const read = page.locator('[data-tool="read"][data-state="ok"]').first()
    await expect(read).toBeVisible()
    await read.getByRole('button', { expanded: false }).first().click()
    await expect(read.getByText('CHECKPOINT_OK', { exact: false })).toBeVisible()
    await read.getByRole('button', { expanded: true }).first().click()
    await info.attach('checkpoint-reference', { body: marker, contentType: 'text/plain' })
    await page.screenshot({ path: info.outputPath('native-search-checkpoint.png'), fullPage: true })
  } finally {
    try { if (before) await restoreMode(page, before) }
    finally { await unlink(fixture) }
  }
})
