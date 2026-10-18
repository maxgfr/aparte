import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

/*
 * The live suite (e2e-live/): the production build against real model servers, run by a developer on their own
 * machine with `bun run test:live`, never in CI. It may hold a real API key, so nothing it records may keep one:
 * no trace, video or screenshot, results written outside the repository, one worker, and a list reporter that never
 * prints request headers or bodies.
 */

if (process.env.CI) throw new Error('The live suite talks to real providers with real keys and never runs in CI')

const port = Number(process.env.E2E_PORT ?? 4174)
const base = process.env.VITE_BASE ?? '/aparte/'
const origin = `http://localhost:${port}`
const preview = `bunx vite preview --port ${port} --strictPort`
const command = process.env.E2E_NO_BUILD === '1' ? preview : `bunx vite build && ${preview}`

export default defineConfig({
  testDir: 'e2e-live',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  outputDir: join(tmpdir(), 'aparte-live-results'),
  reporter: 'list',
  use: {
    baseURL: `${origin}${base}`,
    // Requests of a page its service worker controls bypass the test's routes; the network gate must see them all.
    serviceWorkers: 'block',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  webServer: {
    command,
    url: `${origin}${base}`,
    env: { VITE_ORIGIN: origin, VITE_BASE: base },
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } },
  ],
})
