import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'

// Live sessions share host navigation state; keep these requests sequential.
test.describe.configure({ mode: 'serial' })

// Opt-in: consumes plan usage. Requires an isolated signed-in host with
// nativeFiles=true and a vision-capable default model.
async function session(page: Page) {
  test.skip(process.env.DSH_CAPABILITIES_TEST !== '1' || !process.env.DSH_WEB_LOG, 'Enable live capability tests explicitly')
  test.setTimeout(180_000)
  page.setDefaultTimeout(15_000)
  let url: string | undefined
  await expect.poll(async () => {
    const log = await readFile(process.env.DSH_WEB_LOG!, 'utf8').catch(() => '')
    url = log.match(/dsh web: (http[^\s]+)/)?.[1]
    return !!url
  }, { timeout: 15_000, message: 'Wait for the isolated DSH Web startup' }).toBe(true)
  await page.addInitScript(() => localStorage.setItem('dsh-chatgpt-sub:welcome', '1'))
  await page.goto(url!, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await expect(page.getByRole('button', { name: /^Select model/ })).toBeVisible({ timeout: 45_000 })
}

function pdf(marker: string): Buffer {
  const content = `BT /F1 32 Tf 50 700 Td (${marker}) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`]
  let data = '%PDF-1.4\n'
  const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(data.length); data += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const start = data.length
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(data)
}

test('native PDF reads a marker found only in document bytes', async ({ page }, info) => {
  await session(page)
  const marker = randomBytes(5).toString('hex').toUpperCase()
  await page.locator('[contenteditable=true][role=textbox]').fill('Read the attached PDF directly. Do not use tools, search or read files. Reply only with the ten-character code printed on the page.')
  await page.locator('input[type=file]').setInputFiles({ name: 'document.pdf', mimeType: 'application/pdf', buffer: pdf(marker) })
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await expect(send).toBeEnabled({ timeout: 30_000 }); await send.click()
  await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: /^Stop/ })).toHaveCount(0, { timeout: 30_000 })
  await page.screenshot({ path: info.outputPath('native-pdf.png'), fullPage: true })
})
