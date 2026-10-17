// The subset of the Trusted Types API the app uses. TypeScript's DOM library does not declare it yet, and the API is
// absent in some browsers, which is why `trustedTypes` is optional.

interface TrustedScriptURL {
  readonly __trustedScriptURL: never
  toJSON(): string
  toString(): string
}

interface TrustedHTML {
  readonly __trustedHTML: never
  toJSON(): string
  toString(): string
}

interface TrustedTypePolicyOptions {
  createHTML?: (input: string, ...args: unknown[]) => string
  createScriptURL?: (input: string, ...args: unknown[]) => string
}

interface TrustedTypePolicy {
  readonly name: string
  createHTML(input: string, ...args: unknown[]): TrustedHTML
  createScriptURL(input: string, ...args: unknown[]): TrustedScriptURL
}

interface TrustedTypePolicyFactory {
  createPolicy(name: string, options: TrustedTypePolicyOptions): TrustedTypePolicy
  isScriptURL(value: unknown): value is TrustedScriptURL
  readonly defaultPolicy: TrustedTypePolicy | null
}

interface Window {
  readonly trustedTypes?: TrustedTypePolicyFactory
}

interface WorkerGlobalScope {
  readonly trustedTypes?: TrustedTypePolicyFactory
}
