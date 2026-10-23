import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/browser', fullyParallel: true,
  // A live host shares navigation and settings across every spec file.
  workers: process.env.DSH_WEB_LOG ? 1 : undefined,
  use: { browserName: 'chromium', headless: true, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } },
})
