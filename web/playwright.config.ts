import { defineConfig, devices } from '@playwright/test'

// E2E_PORT: another port when 4173 is taken by something else.
const port = Number(process.env.E2E_PORT ?? 4173)
const base = process.env.VITE_BASE ?? '/aparte/'
const origin = `http://localhost:${port}`

// The production build bakes its origin into the Content-Security-Policy (scripts load from `<origin><base>` only),
// so the build under test is made for the preview origin. E2E_NO_BUILD=1 serves a `dist` built beforehand, which must
// then have been built with the same VITE_ORIGIN.
const preview = `bunx vite preview --port ${port} --strictPort`
const command = process.env.E2E_NO_BUILD === '1' ? preview : `bunx vite build && ${preview}`

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: `${origin}${base}`,
    // The shell is a PWA: the offline and header specs need the service worker to install and take control.
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    command,
    url: `${origin}${base}`,
    env: { VITE_ORIGIN: origin, VITE_BASE: base },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
    { name: 'chromium-phone', use: { ...devices['Pixel 7'] } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-iphone', use: { ...devices['iPhone 15'] } },
    { name: 'firefox-desktop', use: { ...devices['Desktop Firefox'] } },
  ],
})
