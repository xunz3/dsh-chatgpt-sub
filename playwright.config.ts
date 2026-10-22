import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/browser', fullyParallel: true,
  use: { browserName: 'chromium', headless: true, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } },
})
