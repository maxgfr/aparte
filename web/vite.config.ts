import { execSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { cspPlugin } from './build/csp.ts'
import { ortPlugin } from './build/ort.ts'
import { sandboxPlugin } from './build/sandbox.ts'
import { pwaOptions } from './pwa.config.ts'

/** Path the app is served under; GitHub Pages serves the repo at `/aparte/`. */
const base = process.env.VITE_BASE ?? '/aparte/'
/** Origin baked into the Content-Security-Policy (scripts are allowed from `<origin><base>` only). */
const origin = process.env.VITE_ORIGIN ?? 'https://maxgfr.github.io'
/** A build for an origin of its own may offer passkey (PRF) unlock and "stay unlocked on this device". */
const dedicatedOrigin = process.env.DEDICATED_ORIGIN === '1'

/** Runs a git command; null where git or the answer is unavailable (a source tarball, a shallow clone). */
function git(args: string): string | null {
  try {
    const out = execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
    return out || null
  } catch {
    return null
  }
}

/** The release built: CI's `APP_VERSION` (from the semantic-release tag), else the latest tag, else `0.0.0-dev`. */
const version = process.env.APP_VERSION || git('describe --tags --abbrev=0')?.replace(/^v/, '') || '0.0.0-dev'
/** The short commit built: CI's `GITHUB_SHA`, else git's HEAD, else `dev`. */
const commit = process.env.GITHUB_SHA?.slice(0, 7) || git('rev-parse --short HEAD') || 'dev'

export default defineConfig({
  base,
  // What Settings › About shows as this build (src/app/buildInfo.ts).
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
    __DEDICATED_ORIGIN__: JSON.stringify(dedicatedOrigin),
  },
  plugins: [
    react(),
    cspPlugin({ origin, base }),
    ortPlugin(),
    sandboxPlugin({ origin, base }),
    VitePWA(pwaOptions(base)),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // A stable name for the passphrase strength dictionaries, so the service worker can leave them out of the
        // precache (pwa.config.ts) and fetch them only on the vault creation screen.
        manualChunks: (id: string) => (id.includes('@zxcvbn-ts/') ? 'zxcvbn' : undefined),
      },
    },
  },
})
