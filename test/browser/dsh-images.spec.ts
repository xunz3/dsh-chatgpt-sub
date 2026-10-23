import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

// Explicit opt-in: creates one session and makes two paid/plan-backed requests.
// Use an isolated, signed-in DSH Web instance with a vision-capable default model.
test('native image upload recognizes two images and retains them for a follow-up', async ({ page }, testInfo) => {
  test.skip(process.env.DSH_IMAGE_TEST !== '1' || !process.env.DSH_WEB_LOG, 'Set DSH_IMAGE_TEST=1 and DSH_WEB_LOG for live image inference')
  test.setTimeout(180_000)
  page.setDefaultTimeout(15_000)
  const log = await readFile(process.env.DSH_WEB_LOG!, 'utf8')
  const url = log.match(/dsh web: (http[^\s]+)/)?.[1]
  if (!url) throw new Error('The log has no DSH Web startup URL')
  await page.addInitScript(() => localStorage.setItem('dsh-chatgpt-sub:welcome', '1'))
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await expect(page.getByRole('button', { name: /^Select model/ })).toBeVisible({ timeout: 45_000 })

  // The random marker exists only in pixels, never in filenames or prompt text.
  const marker = randomBytes(3).toString('hex').toUpperCase()
  const pngs = await page.evaluate(marker => ['red', 'blue'].map((color, index) => {
    const canvas = document.createElement('canvas')
    canvas.width = 480; canvas.height = 320
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 480, 320)
    ctx.fillStyle = color
    if (index === 0) { ctx.beginPath(); ctx.arc(240, 125, 85, 0, 2 * Math.PI); ctx.fill() }
    else ctx.fillRect(155, 40, 170, 170)
    ctx.fillStyle = 'black'; ctx.font = '36px monospace'; ctx.textAlign = 'center'
    ctx.fillText(index === 0 ? marker : 'SECOND', 240, 280)
    return canvas.toDataURL('image/png').split(',')[1]!
  }), marker)
  const editor = page.locator('[contenteditable=true][role=textbox]')
  await editor.fill('Image integration test. Do not use tools or read files. Identify the color of the large shape in each attached image, in attachment order. Reply only with a JSON array of two lowercase English color names; do not transcribe the text in the images.')
  await page.locator('input[type=file]').setInputFiles(pngs.map((data, i) => ({ name: `fixture-${i + 1}.png`, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') })))
  await page.screenshot({ path: testInfo.outputPath('image-composer.png'), fullPage: true })
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await send.click()
  await expect(page.getByText(/^\[\s*"red"\s*,\s*"blue"\s*\]$/)).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0, { timeout: 30_000 })

  // Ask for information not present in the first answer, with no new upload.
  await editor.fill('Without using tools or reading files, read the six-character code printed at the bottom of the FIRST image from my previous message. Reply only with that code.')
  await send.click()
  await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0, { timeout: 30_000 })
  await page.screenshot({ path: testInfo.outputPath('native-image-followup.png'), fullPage: true })
})
