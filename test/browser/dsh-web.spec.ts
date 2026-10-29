import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

// Opt in only with an isolated, running DSH Web profile (no signed-in accounts).
// Complete DSH's first-run notice before running this test.
test('installed plugin loads in DSH Web and owns a cancellable OAuth callback', async ({ page, request }, testInfo) => {
  test.skip(!process.env.DSH_WEB_LOG, 'Set DSH_WEB_LOG to an isolated DSH Web startup log')
  const log = await readFile(process.env.DSH_WEB_LOG!, 'utf8')
  const url = log.match(/dsh web: (http[^\s]+)/)?.[1]
  if (!url) throw new Error('The log has no DSH Web startup URL')
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'ChatGPT', exact: true }).click()
  const panel = page.getByRole('region', { name: 'ChatGPT', exact: true })
  await expect(panel.getByText('Not connected', { exact: true })).toBeVisible()
  await panel.getByText('Network and remote hosts', { exact: true }).click()
  await expect(panel.getByText('Requests use the Harness launcher’s proxy policy (HTTP(S)_PROXY / NO_PROXY).', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click()
  try {
    const link = panel.getByRole('link', { name: 'Open ChatGPT sign-in' })
    await expect(link).toBeVisible()
    const authorization = new URL((await link.getAttribute('href'))!)
    expect(authorization.origin + authorization.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('nonce')).toBeTruthy()
    expect(authorization.searchParams.get('state')).toBeTruthy()
    const callback = new URL(authorization.searchParams.get('redirect_uri')!)
    expect(callback.hostname).toBe('127.0.0.1')
    expect(callback.pathname).toBe('/auth/callback')
    const response = await request.get(`${callback}?state=wrong&code=invalid&client_id=invalid`)
    expect(response.status()).toBe(400)
    await page.screenshot({ path: testInfo.outputPath('dsh-web-login.png'), fullPage: true })
    await panel.getByRole('button', { name: 'Cancel sign-in', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toBeVisible()
    await expect(request.get(callback.href, { timeout: 2000 })).rejects.toThrow(/ECONNREFUSED/)
    await panel.getByRole('button', { name: 'Refresh status', exact: true }).click()
    await expect(panel.getByText('Not connected', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    const cancel = panel.getByRole('button', { name: 'Cancel sign-in', exact: true })
    if (await cancel.isVisible()) await cancel.click()
  }
})
