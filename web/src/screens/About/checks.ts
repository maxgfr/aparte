/*
 * What About reports about the protections active in this page. Each check reads state the browser exposes; none
 * probes a dangerous sink (assigning markup to see whether it throws would itself be the pattern the app bans).
 */

export type TrustedTypesState = 'enforced' | 'available' | 'unsupported'

export interface TrustedTypesInput {
  /** `window.trustedTypes` exists. */
  readonly api: boolean
  /** The app's `aparte` policy was created and mints trusted script URLs. */
  readonly policy: boolean
  /** The page's Content-Security-Policy requires Trusted Types for scripts. */
  readonly required: boolean
}

/** Enforced only when the browser has the API, the policy exists and the page's policy demands it. */
export function classifyTrustedTypes({ api, policy, required }: TrustedTypesInput): TrustedTypesState {
  if (!api) return 'unsupported'
  return policy && required ? 'enforced' : 'available'
}

/** Whether a Content-Security-Policy text carries `require-trusted-types-for 'script'`. */
export function cspRequiresTrustedTypes(csp: string | null | undefined): boolean {
  if (!csp) return false
  return csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .some(([name, ...values]) => name?.toLowerCase() === 'require-trusted-types-for' && values.includes("'script'"))
}

export type WorkerState = 'active' | 'inactive' | 'unsupported'
export type StorageState = 'persisted' | 'best-effort' | 'unsupported'
