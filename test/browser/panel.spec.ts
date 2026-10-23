import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import type { Status } from '../../src/shared/types.js'
import type { SearchConfig } from '../../src/shared/search.js'

const signedOut: Status = { accounts: [], flow: { phase: 'idle' }, proxyMode: 'inherit' }
const connected: Status = { accounts: [{ id: 'account-first', email: 'reader@example.com', connected: true, sharing: true }, { id: 'account-second', email: 'reader@example.com', connected: false, sharing: false }], activeId: 'account-first', flow: { phase: 'done' }, proxyMode: 'inherit' }

function searchFormSource(config: SearchConfig = {}, writable = true, refuse = false) {
  return `
    let searchSnapshot = { status: 'ready', value: ${JSON.stringify(config)}, writable: ${writable}, revision: 0 };
    const searchListeners = new Set(); window.searchWrites = [];
    const searchForm = {
      getSnapshot: () => searchSnapshot,
      subscribe: listener => { searchListeners.add(listener); return () => searchListeners.delete(listener) },
      set: async (field, value) => {
        window.searchWrites.push({ field, value });
        if (${refuse}) return false;
        searchSnapshot = { ...searchSnapshot, value: { ...searchSnapshot.value, [field]: value }, revision: searchSnapshot.revision + 1 };
        for (const listener of searchListeners) listener();
        return true;
      },
    };
  `
}

async function mount(page: Page, state: Status, dark = false, zh = false, config: SearchConfig = {}, writable = true, refuse = false) {
  await page.route('http://fixture.local/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root"></main></body></html>' }))
  await page.goto('http://fixture.local/')
  await page.addStyleTag({ content: `body{margin:0;padding:32px;font-family:system-ui;background:${dark ? '#18191b' : '#fff'};color:${dark ? '#eee' : '#202124'}}:root{--dsw-alias-bg-base:${dark ? '#18191b' : '#fff'};--dsw-alias-bg-layer-1:${dark ? '#222326' : '#f7f7f7'};--dsw-alias-label-primary:${dark ? '#eee' : '#202124'};--dsw-alias-label-secondary:${dark ? '#a3a4aa' : '#65676b'};--dsw-alias-border-l1:${dark ? '#36373b' : '#ddd'};--dsw-alias-border-l2:${dark ? '#45464a' : '#ccc'}}@media(max-width:480px){body{padding:20px}}` })
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { Panel } from './src/client/Panel.tsx'; import { en, zh } from './src/client/messages.ts';
    ${searchFormSource(config, writable, refuse)}
    let state = ${JSON.stringify(state)};
    const api = {
      status: async()=>structuredClone(state),
      login: async()=>{state.flow={phase:'pending',url:'https://auth.openai.com/api/accounts/authorize?test=1',callback:'http://127.0.0.1:45678/auth/callback'};return structuredClone(state)},
      cancel: async()=>{state.flow={phase:'idle'};return structuredClone(state)},
      select: async(id)=>{state.activeId=id;return structuredClone(state)},
      logout: async(id)=>{const a=state.accounts.find(a=>a.id===id);a.connected=false;a.sharing=false;return structuredClone(state)},
    }; createRoot(document.getElementById('root')).render(<Panel api={api} searchForm={searchForm} t={key=>${zh ? 'zh' : 'en'}[key]}/>);
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false })
  await page.addScriptTag({ content: result.outputFiles[0].text })
}

test('sign-in, safe external link, cancellation and keyboard focus', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await mount(page, signedOut)
  await page.getByRole('button', { name: 'Continue with ChatGPT' }).click()
  await expect(page.getByRole('link', { name: 'Open ChatGPT sign-in' })).toHaveAttribute('rel', 'noreferrer')
  await expect(page.getByRole('link', { name: 'Open ChatGPT sign-in' })).toHaveAttribute('href', /https:\/\/auth.openai.com/)
  await page.getByRole('button', { name: 'Cancel sign-in' }).click()
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeFocused()
  expect(errors).toEqual([])
  await page.screenshot({ path: 'test-results/chatgpt-light.png', fullPage: true })
})
test('first-use modal, account switch and sign-out never expose credentials', async ({ page }) => {
  await mount(page, connected)
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Got it' })).toBeFocused()
  await page.getByRole('button', { name: 'Got it' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'View in ChatGPT' })).toHaveAttribute('href', 'https://chatgpt.com/settings/usage')
  await page.getByText('Manage', { exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('combobox', { name: 'Switch account' })).not.toBeVisible()
  await expect(page.getByText('Manage', { exact: true })).toBeFocused()
  await page.getByText('Manage', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Switch account' }).selectOption('account-second')
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Switch account' }).selectOption('account-first')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
  await expect(page.locator('input[type=password]')).toHaveCount(0)
})
test('dark mobile Chinese UI stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 })
  await mount(page, connected, true, true)
  await page.getByRole('button', { name: '知道了' }).click()
  await page.getByText('网络与远程主机', { exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByRole('link', { name: '在 ChatGPT 查看' })).toBeVisible()
  await page.screenshot({ path: 'test-results/chatgpt-dark-mobile.png', fullPage: true })
})

test('account management identifies registrations and shows plan access for the selected account', async ({ page }) => {
  await mount(page, connected)
  await page.getByRole('button', { name: 'Got it' }).click()
  await expect(page.locator('.cgs-current')).toContainText('reader@example.com')
  const plan = page.getByRole('region', { name: 'Plan & usage' })
  await expect(plan.getByRole('link', { name: 'View in ChatGPT' })).toBeVisible()
  await page.screenshot({ path: 'test-results/chatgpt-connected.png', fullPage: true })
  await page.getByText('Manage', { exact: true }).click()
  await expect(page.locator('.cgs-account-controls')).toContainText('-first')
  await expect(page.getByText('Switching accounts stops requests in progress.', { exact: false })).toBeVisible()
  await page.getByRole('combobox', { name: 'Switch account' }).selectOption('account-second')
  await expect(page.locator('.cgs-account-controls')).toContainText('second')
  await expect(plan).toHaveCount(0)
})

test('a pending status from the previous connection cannot overwrite the new account', async ({ page }) => {
  await page.route('http://fixture.local/', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }))
  await page.goto('http://fixture.local/')
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { Panel } from './src/client/Panel.tsx'; import { en } from './src/client/messages.ts';
    ${searchFormSource()}
    localStorage.setItem('dsh-chatgpt-sub:welcome', '1');
    const state = ${JSON.stringify(connected)};
    const root = createRoot(document.getElementById('root')); const t = key => en[key];
    window.pollCalls = 0;
    const oldApi = { status: () => { window.pollCalls++; return new Promise(resolve => { window.resolveOld = () => resolve(state) }) } };
    const newApi = { status: async () => ({ ...state, activeId: 'account-second' }) };
    window.swapConnection = () => root.render(<Panel api={newApi} searchForm={searchForm} t={t}/>);
    root.render(<Panel api={oldApi} searchForm={searchForm} t={t}/>);
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false })
  await page.addScriptTag({ content: result.outputFiles[0].text })
  await expect.poll(() => page.evaluate(() => typeof (window as any).resolveOld)).toBe('function')
  await page.evaluate(() => (window as any).swapConnection())
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
  await page.evaluate(() => (window as any).resolveOld())
  await page.clock.install()
  await page.clock.fastForward(2500)
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
  expect(await page.evaluate(() => (window as any).pollCalls)).toBe(1)
})

test('account menu dismisses outside and on focus leave, but preserves internal interaction', async ({ page }) => {
  await mount(page, connected)
  await page.getByRole('button', { name: 'Got it' }).click()
  const trigger = page.locator('.cgs-account-menu > summary')
  const menu = page.locator('.cgs-account-menu')
  await trigger.click()
  await expect(menu).toHaveAttribute('open', '')
  await page.getByRole('combobox', { name: 'Switch account' }).focus()
  await expect(menu).toHaveAttribute('open', '')
  await page.getByRole('button', { name: 'Refresh status' }).click()
  await expect(menu).toHaveAttribute('open', '')
  await page.getByRole('heading', { name: 'ChatGPT', exact: true }).click()
  await expect(menu).not.toHaveAttribute('open', '')
  await trigger.click()
  await page.getByRole('link', { name: 'View in ChatGPT' }).focus()
  await expect(menu).not.toHaveAttribute('open', '')
  await trigger.click()
  await page.getByRole('combobox', { name: 'Switch account' }).focus()
  await page.keyboard.press('Escape')
  await expect(menu).not.toHaveAttribute('open', '')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await trigger.click()
  await expect(menu).not.toHaveAttribute('open', '')
})

test('search has an explicit provider-scoped mode and writes only the selected field', async ({ page }) => {
  await mount(page, signedOut)
  const select = page.getByRole('combobox', { name: 'Web search' })
  await expect(select).toHaveValue('native')
  await expect(select.locator('option')).toHaveText(['OpenAI native (default)', 'Harness tools', 'Off'])
  await expect(page.getByText('GPT can use OpenAI search outside Harness tool approvals and URL rules.')).toBeVisible()
  await expect(page.getByText('ChatGPT conversations only. Code, MCP and other network tools keep their Harness permissions.')).toBeVisible()
  await select.selectOption('harness')
  await expect(select).toHaveValue('harness')
  await expect(page.getByText('Use the session’s Harness search tools and permissions.')).toBeVisible()
  await select.selectOption('off')
  await expect(page.getByText('Do not offer OpenAI or Harness search directly.')).toBeVisible()
  expect(await page.evaluate(() => (window as any).searchWrites)).toEqual([{ field: 'searchMode', value: 'harness' }, { field: 'searchMode', value: 'off' }])
})

test('read-only settings cannot mutate and rejected writes keep the accepted mode', async ({ page }) => {
  await mount(page, signedOut, false, false, { searchMode: 'harness' }, false)
  const select = page.getByRole('combobox', { name: 'Web search' })
  await expect(select).toBeDisabled()
  await expect(page.getByText('This host’s settings are read-only.')).toBeVisible()
  await mount(page, signedOut, false, false, { searchMode: 'harness' }, true, true)
  await select.selectOption('native')
  await expect(select).toHaveValue('harness')
  await expect(page.getByRole('alert')).toContainText('Could not save the search mode')
})
