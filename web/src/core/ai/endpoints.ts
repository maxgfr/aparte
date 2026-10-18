/*
 * OpenAI-compatible servers the user points the app at: local ones (Ollama, LM Studio, Jan) from presets, and any
 * custom endpoint. An endpoint is accepted only over HTTPS, or plain HTTP on this machine's loopback, so a key never
 * crosses the network in clear (llm-connect `endpointProblem`, the same rule web/src/security/net.ts enforces).
 */
import { ENDPOINT_PRESETS, type EndpointProblem, endpointProblem } from 'llm-connect'
import type { ProviderConfig } from '../contracts/ai.ts'

export interface LocalPreset {
  /** The `preset` of the provider created from it. */
  readonly id: string
  readonly name: string
  /** Base URL at the server's default port. */
  readonly endpoint: string
  /** Filled in when the user names no model. */
  readonly model?: string
}

/** Local servers at their default port: llm-connect's presets (Ollama, LM Studio, Jan). */
export const LOCAL_PRESETS: readonly LocalPreset[] = [
  ENDPOINT_PRESETS.ollama,
  ENDPOINT_PRESETS.lmstudio,
  ENDPOINT_PRESETS.jan,
]

export type { EndpointProblem }

/** The plain-HTTP hosts web/src/security/net.ts (and the CSP) let through; llm-connect also accepts 127.0.0.0/8 and ::1. */
const HTTP_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1'])

/**
 * What is wrong with a base URL the user typed, or null when it can be called: llm-connect's rule (which also refuses
 * credentials in the URL), narrowed to what the network wrapper allows.
 */
export function baseUrlProblem(url: string): EndpointProblem | null {
  const trimmed = url.trim()
  const problem = endpointProblem(trimmed)
  if (problem !== null) return problem
  const parsed = new URL(trimmed)
  if (parsed.protocol === 'http:' && !HTTP_HOSTS.has(parsed.hostname)) return 'insecure-endpoint'
  return null
}

/** The base URL as stored: trimmed, without a trailing slash; null when `baseUrlProblem` refuses it. */
export function normalizeBaseUrl(url: string): string | null {
  const trimmed = url.trim()
  return baseUrlProblem(trimmed) === null ? trimmed.replace(/\/+$/, '') : null
}

/** The configuration fields of an OpenAI-compatible provider created from a local preset or a custom endpoint. */
export function customProviderFields(
  preset: LocalPreset | { readonly id: 'custom'; readonly name: string; readonly endpoint: string },
): (Pick<ProviderConfig, 'kind' | 'label'> & { readonly baseUrl: string; readonly preset: string }) | null {
  const baseUrl = normalizeBaseUrl(preset.endpoint)
  if (baseUrl === null) return null
  return { kind: 'openai-compatible', label: preset.name, baseUrl, preset: preset.id }
}

/** Whether the base URL is on this machine (a local server reached over plain http or on the loopback). */
export function isLocalEndpoint(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * Whether calling the provider needs a key: every hosted API does; a server on this machine may not, and a model that
 * runs in this browser never does.
 */
export function needsKey(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): boolean {
  if (provider.kind === 'webllm' || provider.kind === 'chrome-ai') return false
  return !(provider.kind === 'openai-compatible' && isLocalEndpoint(provider.baseUrl))
}
