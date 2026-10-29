import { test, expect, type Page } from '@playwright/test'
import { build } from 'esbuild'
import type { Status } from '../../src/shared/types.js'

const signedOut: Status = { accounts: [], flow: { phase: 'idle' } }
const connected: Status = { accounts: [{ id: 'account-one', email: 'reader@example.com', connected: true, sharing: true }], activeId: 'account-one', flow: { phase: 'idle' } }

async function mount(page: Page, state: Status, revokeFailed = false, statusFailures = 0) {
  await page.route('http://fixture.local/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }))
  await page.goto('http://fixture.local/')
  await page.addStyleTag({ content: `body{margin:0;padding:24px;font-family:system-ui}:root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#202124;--dsw-alias-label-secondary:#65676b;--dsw-alias-border-l2:#ccc;--dsw-alias-state-success-primary:#398268}` })
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ProviderCard } from './src/client/ProviderCard.tsx'; import { en } from './src/client/messages.ts';
    let state = ${JSON.stringify(state)};
    let statusFailures = ${statusFailures};
    const api = {
      status: async () => { if (statusFailures-- > 0) throw new Error('Temporary RPC failure'); return structuredClone(state) },
      login: async () => { state.flow = { phase: 'pending', url: 'https://auth.openai.com/api/accounts/authorize?test=1' }; return structuredClone(state) },
      cancel: async () => { state.flow = { phase: 'idle' }; return structuredClone(state) },
      select: async () => structuredClone(state),
      logout: async () => { state = { ...state, accounts: state.accounts.map(account => ({ ...account, connected: false, sharing: false })), ...(${revokeFailed} ? { notice: 'Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.' } : {}) }; return structuredClone(state) },
    };
    createRoot(document.getElementById('root')).render(<ProviderCard api={api} t={key => en[key]}/>);
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false })
  await page.addScriptTag({ content: result.outputFiles[0].text })
}

test('Models provider card starts sign-in, exposes the link and cancels', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await mount(page, signedOut)
  const card = page.getByRole('region', { name: 'ChatGPT plan' })
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Continue with ChatGPT' }).click()
  await expect(card.getByText('Complete sign-in in your browser.', { exact: true })).toBeVisible()
  await expect(card.getByRole('link', { name: 'Open ChatGPT sign-in' })).toHaveAttribute('href', /auth\.openai\.com/)
  await card.getByRole('button', { name: 'Cancel sign-in' }).click()
  await expect(card.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible()
  await expect(card.getByText('Full options, accounts and web search are under Settings → ChatGPT.')).toBeVisible()
  await page.screenshot({ path: 'test-results/provider-card.png' })
  expect(errors).toEqual([])
})

test('Models provider card shows the connected account and signs out', async ({ page }) => {
  await mount(page, connected)
  const card = page.getByRole('region', { name: 'ChatGPT plan' })
  await expect(card.getByText('reader@example.com · Connected', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
})

test('a successful focus refresh clears a transient status error without an account action', async ({ page }) => {
  await mount(page, connected, false, 1)
  await expect(page.getByRole('alert')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('reader@example.com · Connected', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('Models sign-out preserves the remote revocation warning and recovery link', async ({ page }) => {
  await mount(page, connected, true)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByText('Not connected', { exact: true })).toBeVisible()
  const notice = page.getByRole('status')
  await expect(notice).toContainText('Remote revocation was not confirmed')
  const link = notice.getByRole('link', { name: 'Open ChatGPT settings' })
  await expect(link).toHaveAttribute('href', 'https://chatgpt.com/settings/usage')
  await expect(link).toHaveAttribute('rel', 'noreferrer')
})
