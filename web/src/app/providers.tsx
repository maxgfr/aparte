import { useMemo } from 'react'
import type { Catalog, CatalogModel, CatalogProvider } from '../core/ai/catalog.ts'
import { catalogModelInfo, findModel, findProvider, sortedModels } from '../core/ai/catalog.ts'
import { baseUrlProblem, isLocalEndpoint, LOCAL_PRESETS, type LocalPreset, needsKey } from '../core/ai/endpoints.ts'
import type { CapabilitiesModule, ModelDescriptor, ProviderConfig, ProviderKind } from '../core/contracts/ai.ts'
import type { ModelRef, Workspace } from '../core/contracts/workspace.ts'
import { useProviders, useSession } from './chat.tsx'

/*
 * Model providers for the interface: where a new provider comes from (the bundled catalog of providers a browser can
 * call, a local server preset, or a custom endpoint), whether one needs a key, and how a model reference resolves to
 * the descriptor the chat sends with (spec/DATA-MODEL.md section 3.3).
 *
 * Invariants:
 * - A provider configuration never holds a key: the key is a `provider-key` local record (ProviderKeys), entered on
 *   the provider screen and read only by the chat controller and the connection test.
 * - A model's capabilities come from core/ai/capabilities.ts (the pinned tables, the catalog entry, conservative
 *   defaults), then the user's per-model overrides; the interface offers only what they allow.
 */

/** Where the user gets a key for a maker's own API (the catalog lists documentation pages, not key pages). */
export const KEY_PAGES: Readonly<Partial<Record<ProviderKind, string>>> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  mistral: 'https://console.mistral.ai/api-keys',
  openrouter: 'https://openrouter.ai/settings/keys',
}

/** How many catalog models a new provider offers in the picker until the user changes the list. */
export const INITIAL_MODELS = 12

export { isLocalEndpoint, LOCAL_PRESETS, type LocalPreset, needsKey }

/** The local preset a provider was made from, if any. */
export function localPresetOf(provider: Pick<ProviderConfig, 'kind' | 'preset'>): LocalPreset | undefined {
  return provider.kind === 'openai-compatible' ? LOCAL_PRESETS.find((p) => p.id === provider.preset) : undefined
}

/** The catalog provider a configured provider was made from: its `preset`, or its kind for a maker's own API. */
export function catalogProviderOf(
  catalog: Catalog | null,
  provider: Pick<ProviderConfig, 'kind' | 'preset'>,
): CatalogProvider | undefined {
  if (catalog === null) return undefined
  return findProvider(catalog, provider.kind === 'openai-compatible' ? (provider.preset ?? '') : provider.kind)
}

/** The service a provider talks to, as the user knows it; null for a custom endpoint. */
export function serviceName(catalog: Catalog | null, provider: Pick<ProviderConfig, 'kind' | 'preset'>): string | null {
  return localPresetOf(provider)?.name ?? catalogProviderOf(catalog, provider)?.name ?? null
}

/** Kinds this build can call: every hosted kind, and the on-device ones (WebLLM, Chrome's built-in model). */
export function isCallable(kind: ProviderKind): boolean {
  return KINDS.has(kind)
}

const KINDS: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  'anthropic',
  'openai',
  'google',
  'mistral',
  'openrouter',
  'openai-compatible',
  'webllm',
  'chrome-ai',
])

/** The first catalog models of a provider, newest first: what a new provider offers until the user edits its list. */
export function initialModels(entry: CatalogProvider | undefined): string[] {
  return entry === undefined
    ? []
    : sortedModels(entry)
        .slice(0, INITIAL_MODELS)
        .map((m) => m.id)
}

/** The models a provider offers in the picker, in its order. */
export function modelsOf(provider: ProviderConfig): readonly string[] {
  if (provider.models !== undefined && provider.models.length > 0) return provider.models
  return provider.defaultModel === undefined ? [] : [provider.defaultModel]
}

/** The catalog entry of a provider's model, if the catalog knows it. */
export function catalogModelOf(
  catalog: Catalog | null,
  provider: Pick<ProviderConfig, 'kind' | 'preset'>,
  modelId: string,
): CatalogModel | undefined {
  return catalog === null ? undefined : findModel(catalog, provider, modelId)
}

/**
 * The descriptor of a model reference, or null when its provider is unknown, trashed or of a kind this build cannot
 * call. `catalog` is null until the bundled catalog has loaded (capabilities are then the conservative defaults).
 */
export function resolveModelWith(
  ws: Workspace,
  caps: CapabilitiesModule,
  catalog: Catalog | null,
  ref: ModelRef,
): ModelDescriptor | null {
  const provider = ws.providers.get(ref.provider)
  if (provider === undefined || provider.deletedAt !== undefined || !isCallable(provider.kind)) return null
  const entry = catalogModelOf(catalog, provider, ref.id)
  const override = provider.overrides?.[ref.id]
  const capabilities = caps.resolveCapabilities({
    kind: provider.kind,
    modelId: ref.id,
    ...(entry === undefined ? {} : { catalog: catalogModelInfo(entry) }),
    ...(override === undefined ? {} : { override }),
  })
  return { ref, kind: provider.kind, name: entry?.name ?? ref.id, capabilities }
}

/** What is wrong with a base URL the user typed, or null: the network wrapper's own rule. */
export { baseUrlProblem }

/** A model the picker offers, with the provider it goes through. */
export interface ModelChoice {
  readonly provider: ProviderConfig
  readonly model: ModelDescriptor
}

/** Every model of every usable provider, grouped by provider in the providers' order. */
export function useModelChoices(): readonly ModelChoice[] {
  const session = useSession()
  const providers = useProviders()
  return useMemo(() => {
    if (session === null) return []
    const out: ModelChoice[] = []
    for (const provider of providers) {
      if (!isCallable(provider.kind)) continue
      for (const id of modelsOf(provider)) {
        const model = session.resolveModel({ provider: provider.id, id })
        if (model !== null) out.push({ provider, model })
      }
    }
    return out
  }, [session, providers])
}

/** Two references to the same model. */
export function sameModel(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return a != null && b != null && a.provider === b.provider && a.id === b.id
}
