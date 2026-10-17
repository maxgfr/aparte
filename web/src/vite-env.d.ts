/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Replaced at build time by vite.config.ts `define`. Under `bun test` they are undefined, so readers guard with
// `typeof` (see src/app/buildInfo.ts).

/** The release built: CI's tag, else the latest git tag, else `0.0.0-dev`. */
declare const __APP_VERSION__: string
/** The short commit built, or `dev`. */
declare const __APP_COMMIT__: string
/** True when the build targets an origin of its own (passkey unlock and "stay unlocked" become possible). */
declare const __DEDICATED_ORIGIN__: boolean
