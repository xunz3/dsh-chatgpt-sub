import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('Models settles without repeated provider invalidation in the installed host', async ({ page }, testInfo) => {
  test.skip(!process.env.DSH_WEB_LOG, 'Set DSH_WEB_LOG to a running DSH Web startup log')
  const log = await readFile(process.env.DSH_WEB_LOG!, 'utf8')
  const url = log.match(/dsh web: (http[^\s]+)/)?.[1]
  if (!url) throw new Error('The log has no DSH Web startup URL')
  let providerRequests = 0
  const failures: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/llm/listProviders') providerRequests++
  })
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) failures.push(request.failure()?.errorText ?? 'Request failed')
  })
  const directory = page.waitForResponse(response => new URL(response.url()).pathname === '/api/llm/listProviders' && response.status() === 200)
  await page.goto(url)
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  const providers = await (await directory).json()
  expect(providers.result.ok).toBe(true)
  expect(providers.result.value).toContainEqual({ id: 'chatgpt-sub', name: 'ChatGPT plan' })
  await expect(page.getByRole('button', { name: 'Add model provider', exact: true })).toBeVisible({ timeout: 15_000 })
  // Observe beyond initial rendering: unchanged token reads must not keep
  // triggering credentials/record-updated -> modelCatalog -> token reads.
  const settled = providerRequests
  await page.waitForTimeout(3000)
  expect(providerRequests - settled).toBeLessThanOrEqual(1)
  expect(providerRequests).toBeLessThan(10)
  expect(failures).toEqual([])
  await expect(page.getByText('Loading the provider directory failed', { exact: false })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('models.png'), fullPage: true })
})
