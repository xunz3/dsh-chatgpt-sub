import { test, expect } from '@playwright/test'
import { build } from 'esbuild'

test('settings icon follows section registrations without modifying host nodes', async ({ page }) => {
  await page.setContent('<div id="settings"></div><nav><div><button id="outside"><svg></svg>ChatGPT</button></div></nav>')
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { SlotCore, resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots';
    import { mountSettingsIcon } from './src/client/settings-icon.ts';
    const slots = new SlotCore();
    slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } }, () => null);
    // Match DSH 0.2.1 SettingsRoot: title div, then direct button rows sorted by order.
    const render = () => {
      const panel = document.createElement('div'); panel.dataset.shortcutModal = 'settings';
      const nav = document.createElement('nav'); const title = document.createElement('div');
      title.innerHTML = '<button id="header-action"><svg></svg>ChatGPT</button>';
      const list = document.createElement('div');
      for (const entry of [...slots.entries('settings.section')].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))) {
        const button = document.createElement('button'); button.id = entry.options.id;
        button.innerHTML = '<svg></svg><span></span>'; button.lastChild.textContent = resolveSlotLabel(entry.options.label);
        list.append(button);
      }
      nav.append(title, list); panel.append(nav); document.getElementById('settings').replaceChildren(panel);
    };
    const disposers = new Map();
    window.addSection = (id, order, label) => disposers.set(id, slots.register({ name: 'settings.section', id, order, label }, () => null));
    window.removeSection = id => { disposers.get(id)(); disposers.delete(id) };
    window.remount = render;
    slots.subscribe('settings.section', render);
    window.addSection('general', 0, 'General');
    window.addSection('same-label', 50, 'ChatGPT');
    window.disposeIcon = mountSettingsIcon(slots);
  ` }, bundle: true, platform: 'browser', format: 'iife', write: false })
  await page.addScriptTag({ content: result.outputFiles[0].text })
  const icon = page.locator('#chatgpt-sub > svg')
  const unchanged = page.locator('#general > svg, #same-label > svg, #header-action > svg, #outside > svg')
  const expectUnchanged = async () => {
    for (const svg of await unchanged.all()) await expect(svg).not.toHaveCSS('display', 'none')
  }
  await expectUnchanged()
  await page.evaluate(() => (window as any).addSection('chatgpt-sub', 25, 'ChatGPT'))
  const hostMarkup = await page.locator('#settings').innerHTML()
  await expect(icon).toHaveCSS('display', 'none')
  expect(await page.locator('#chatgpt-sub').evaluate(el => getComputedStyle(el, '::before').maskImage)).toContain('data:image/svg+xml')
  await expectUnchanged()
  await page.evaluate(() => (window as any).addSection('earlier', 10, 'Earlier'))
  await expect(icon).toHaveCSS('display', 'none')
  await expect(page.locator('#earlier > svg')).not.toHaveCSS('display', 'none')
  await page.evaluate(() => { (window as any).removeSection('chatgpt-sub'); (window as any).addSection('chatgpt-sub', 75, 'Localized name') })
  await expect(icon).toHaveCSS('display', 'none')
  await expectUnchanged()
  await page.evaluate(() => (window as any).remount())
  await expect(icon).toHaveCSS('display', 'none')
  await page.evaluate(() => document.querySelector('#earlier')!.remove())
  await expect(icon).not.toHaveCSS('display', 'none') // Unexpected host filtering must not shift the icon onto another row.
  await expectUnchanged()
  await page.evaluate(() => { (window as any).removeSection('chatgpt-sub'); (window as any).removeSection('earlier') })
  await expectUnchanged()
  await page.evaluate(() => (window as any).addSection('chatgpt-sub', 25, 'ChatGPT'))
  await expect(icon).toHaveCSS('display', 'none')
  expect(await page.locator('#settings').innerHTML()).toBe(hostMarkup)
  await page.evaluate(() => (window as any).disposeIcon())
  await expect(icon).not.toHaveCSS('display', 'none')
  expect(await page.locator('#settings').innerHTML()).toBe(hostMarkup)
  await page.evaluate(() => (window as any).addSection('later', 100, 'Later'))
  await expect(icon).not.toHaveCSS('display', 'none')
})
