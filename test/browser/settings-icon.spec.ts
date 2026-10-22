import { test, expect } from '@playwright/test'
import { build } from 'esbuild'

test('settings icon stays scoped, survives nav remounts, and restores the host on unload', async ({ page }) => {
  await page.setContent('<div data-shortcut-modal="settings"><nav><button><svg></svg><span>General</span></button><button id="plugin"><svg></svg><span>ChatGPT</span></button></nav></div><button id="elsewhere">ChatGPT</button>')
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { mountSettingsIcon } from './src/client/settings-icon.ts';
    window.disposeIcon = mountSettingsIcon(() => 'ChatGPT');
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false })
  await page.addScriptTag({ content: result.outputFiles[0].text })
  await expect(page.locator('[data-cgs-settings-icon]')).toHaveCount(1)
  await expect(page.locator('#plugin > svg')).toHaveCSS('display', 'none')
  await expect(page.getByRole('button', { name: 'General' }).locator('svg')).not.toHaveCSS('display', 'none')
  expect(await page.locator('#plugin').evaluate(el => getComputedStyle(el, '::before').maskImage)).toContain('data:image/svg+xml')
  await page.evaluate(() => { document.querySelector('nav')!.innerHTML = '<button id="plugin"><svg></svg><span>ChatGPT</span></button>' })
  await expect(page.locator('#plugin')).toHaveAttribute('data-cgs-settings-icon', '')
  await page.evaluate(() => (window as unknown as { disposeIcon(): void }).disposeIcon())
  await expect(page.locator('[data-cgs-settings-icon]')).toHaveCount(0)
  await expect(page.locator('#plugin > svg')).not.toHaveCSS('display', 'none')
})
