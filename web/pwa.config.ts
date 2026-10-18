import type { VitePWAOptions } from 'vite-plugin-pwa'
import { integrityTransform } from './build/integrity.ts'

/** The precache cap: the app shell is far below it; heavy runtimes over it are fetched on demand, hash-pinned. */
const MAX_PRECACHED_BYTES = 4 * 1024 * 1024

/**
 * The service worker, its precache and the web app manifest.
 *
 * The worker is ours (`src/sw.ts`, built by injectManifest): it checks every precached response against an SRI
 * digest stamped at build time (`build/integrity.ts`) and adds the security headers GitHub Pages cannot send. It is
 * registered by `src/pwa/register.ts` only, never by the plugin, and updates on prompt: a new version waits until
 * the user applies it and nothing holds the reload. Nothing from the network is cached at runtime: no API traffic.
 */
export function pwaOptions(base: string): Partial<VitePWAOptions> {
  // The directory Workbox globs (Vite's resolved `outDir`, whatever `--outDir` says), read back to hash the files.
  let globDirectory: string | undefined
  const builtFiles = () => {
    if (!globDirectory) throw new Error('integrity: the build output directory is not resolved yet')
    return globDirectory
  }
  return {
    strategies: 'injectManifest',
    srcDir: 'src',
    filename: 'sw.ts',
    registerType: 'prompt',
    injectRegister: false,
    base,
    pwaAssets: { config: true, overrideManifestIcons: true },
    manifest: {
      id: './',
      name: 'Aparté',
      short_name: 'Aparté',
      description: 'Private AI chat that never leaves your browser: encrypted on the device, synced end-to-end.',
      lang: 'en',
      start_url: './',
      scope: './',
      display: 'standalone',
      display_override: ['window-controls-overlay', 'standalone'],
      // `--bg` of src/ui/tokens.css (light): the splash and title bar match the first painted frame.
      theme_color: '#f6f4ef',
      background_color: '#f6f4ef',
      launch_handler: { client_mode: 'focus-existing' },
      shortcuts: [{ name: 'New chat', url: './#/new' }],
      // An `.aparte` backup opened with the installed app lands on the Transfer screen, which reads it from the launch
      // queue and offers to merge it (nothing is read before the vault is open).
      file_handlers: [{ action: './#/transfer?launch', accept: { 'application/x-aparte-backup': ['.aparte'] } }],
    },
    injectManifest: {
      // A classic script with everything inlined: no `import` at runtime, so nothing the worker runs escapes the
      // single file `updateViaCache: 'none'` refetches on every update check.
      rollupFormat: 'iife',
      // The app shell: entry and lazy chunks, styles, the document, icons, the web manifest and fonts.
      globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
      globIgnores: [
        // Splash screens are fetched by iOS at install, not by the app: no point precaching dozens of large PNGs.
        '**/apple-splash-*',
        // The passphrase strength dictionaries (about 1.5 MB) only serve the vault creation screen: fetched on demand.
        '**/zxcvbn-*.js',
        // Sandbox frames have an opaque origin, so the worker never sees their requests: precaching them is waste.
        'sandbox/**',
        // The OAuth callback must always come from the network as deployed.
        'oauth-callback.html',
        // Heavy optional runtimes load on demand, pinned by hash in code, never at install.
        'pyodide/**',
        'ort/**',
        'webllm/**',
        // The model workers carry WebLLM and transformers.js with ONNX Runtime (megabytes each): fetched only when an
        // in-browser model or embeddings are used, never at install.
        '**/webllm.worker-*.js',
        '**/transformers.worker-*.js',
        '**/mermaid*',
      ],
      // Files over the cap (a WebAssembly runtime, say) are left out of the precache with a build warning.
      maximumFileSizeToCacheInBytes: MAX_PRECACHED_BYTES,
      manifestTransforms: [integrityTransform(builtFiles)],
    },
    integration: {
      beforeBuildServiceWorker(options) {
        globDirectory = options.injectManifest.globDirectory
      },
    },
    // Off in dev; `VITE_SW_DEV=1 bun run dev` serves the worker from source (as a module) to debug it.
    devOptions: { enabled: process.env.VITE_SW_DEV === '1', type: 'module' },
  }
}
