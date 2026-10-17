// Replaced at build time by vite.config.ts `define` (declared in vite-env.d.ts); absent under `bun test`, hence the
// `typeof` guards and the fallbacks.

/** This build, as About shows it. */
export interface BuildInfo {
  /** The release (semantic-release tag), or `0.0.0-dev` for an untagged build. */
  readonly version: string
  /** Short git commit, or `dev` when the build had no git. */
  readonly commit: string
  /** True for a build served from an origin of its own (not shared with other GitHub Pages sites). */
  readonly dedicatedOrigin: boolean
  /** `production` for `vite build`, `development` under the dev server. */
  readonly mode: 'production' | 'development'
}

export const BUILD: BuildInfo = {
  version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev',
  commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev',
  dedicatedOrigin: typeof __DEDICATED_ORIGIN__ === 'boolean' ? __DEDICATED_ORIGIN__ : false,
  mode: import.meta.env?.PROD ? 'production' : 'development',
}

/** The repository this build comes from; About links to it. */
export const REPOSITORY = 'https://github.com/maxgfr/aparte'
