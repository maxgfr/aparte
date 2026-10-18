/*
 * The tool registry (RegistryModule in web/src/core/contracts/tools.ts): the tools this session can run, with their
 * approval keys and fingerprints, and the drift detection of a conversation's frozen snapshot against them.
 *
 * Invariants:
 * - A name is registered once; `web_search` is reserved for the provider's own search.
 * - A spec is checked and copied when registered: a source that later mutates its object changes nothing here, and
 *   the fingerprint always describes what is declared.
 * - `resolve` declares a snapshot entry only when a tool of the same name, source and origin is registered with the
 *   same fingerprint; anything else is reported as drifted or missing and never declared.
 */
import { InvalidInputError } from '../contracts/crypto.ts'
import {
  type RegisteredTool,
  type SnapshotEntry,
  type Tool,
  type ToolAnnotations,
  type ToolRegistry,
  type ToolSource,
  WEB_SEARCH,
} from '../contracts/tools.ts'
import { approvalKeyOf, canonicalJson, fingerprintOf, webSearchFingerprint } from './fingerprint.ts'

const NAME = /^[A-Za-z0-9_-]{1,64}$/
const SOURCES: ReadonlySet<string> = new Set<ToolSource>(['builtin', 'mcp', 'skill', 'sandbox'])

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function checkAnnotations(value: unknown): ToolAnnotations {
  const a = value as Partial<Record<keyof ToolAnnotations, unknown>> | null
  if (a === null || typeof a !== 'object') throw new InvalidInputError('A tool needs its annotations')
  for (const key of ['readOnly', 'destructive', 'openWorld'] as const) {
    if (typeof a[key] !== 'boolean') throw new InvalidInputError(`annotations.${key} must be a boolean`)
  }
  return { readOnly: a.readOnly as boolean, destructive: a.destructive as boolean, openWorld: a.openWorld as boolean }
}

/** A checked, frozen copy of the tool's spec around its `execute`. */
function checkTool(tool: Tool): Tool {
  if (tool === null || typeof tool !== 'object') throw new InvalidInputError('A tool must be an object')
  if (typeof tool.name !== 'string' || !NAME.test(tool.name)) throw new InvalidInputError('Invalid tool name')
  if (tool.name === WEB_SEARCH) throw new InvalidInputError(`The name ${WEB_SEARCH} is reserved`)
  if (typeof tool.description !== 'string' || tool.description.trim() === '') {
    throw new InvalidInputError('A tool needs a description')
  }
  if (!SOURCES.has(tool.source)) throw new InvalidInputError('Unknown tool source')
  if (tool.origin !== undefined && (typeof tool.origin !== 'string' || tool.origin === '')) {
    throw new InvalidInputError('A tool origin is a non-empty string')
  }
  if (tool.title !== undefined && typeof tool.title !== 'string') throw new InvalidInputError('A title is a string')
  if (typeof tool.execute !== 'function') throw new InvalidInputError('A tool needs execute()')
  const schema = tool.inputSchema as unknown
  if (schema === null || typeof schema !== 'object' || (schema as { type?: unknown }).type !== 'object') {
    throw new InvalidInputError('An input schema is a JSON Schema of type object')
  }
  // A copy through canonical JSON proves the schema is JSON and detaches it from the caller.
  const inputSchema = JSON.parse(canonicalJson(schema)) as Tool['inputSchema']
  const execute = tool.execute.bind(tool)
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: deepFreeze(inputSchema),
    annotations: Object.freeze(checkAnnotations(tool.annotations)),
    source: tool.source,
    ...(tool.origin === undefined ? {} : { origin: tool.origin }),
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.autoApprove === true ? { autoApprove: true } : {}),
    execute,
  })
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredTool>()
  const listeners = new Set<() => void>()
  let listed: readonly RegisteredTool[] | null = null

  const notify = () => {
    listed = null
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }

  return {
    list() {
      listed ??= Object.freeze([...tools.values()].sort((a, b) => byName(a.tool, b.tool)))
      return listed
    },
    get(name) {
      return tools.get(name)
    },
    async register(input) {
      const tool = checkTool(input)
      if (tools.has(tool.name)) throw new InvalidInputError(`A tool named ${tool.name} is registered`)
      const fingerprint = await fingerprintOf(tool)
      if (tools.has(tool.name)) throw new InvalidInputError(`A tool named ${tool.name} is registered`)
      const registered: RegisteredTool = Object.freeze({ tool, approvalKey: approvalKeyOf(tool), fingerprint })
      tools.set(tool.name, registered)
      notify()
      return registered
    },
    unregister(name) {
      if (tools.delete(name)) notify()
    },
    async snapshot(names, options = {}) {
      const out: SnapshotEntry[] = []
      for (const name of new Set(names)) {
        const r = tools.get(name)
        if (r === undefined) continue
        out.push({
          name,
          source: r.tool.source,
          ...(r.tool.origin === undefined ? {} : { origin: r.tool.origin }),
          fingerprint: r.fingerprint,
        })
      }
      if (options.webSearch)
        out.push({ name: WEB_SEARCH, source: 'provider', fingerprint: await webSearchFingerprint() })
      return Object.freeze(out.sort(byName))
    },
    resolve(snapshot) {
      const declared: RegisteredTool[] = []
      const drifted: string[] = []
      const missing: string[] = []
      let webSearch = false
      for (const entry of snapshot) {
        if (entry.source === 'provider') {
          if (entry.name === WEB_SEARCH) webSearch = true
          else missing.push(entry.name)
          continue
        }
        const r = tools.get(entry.name)
        if (r === undefined || r.tool.source !== entry.source || (r.tool.origin ?? null) !== (entry.origin ?? null)) {
          missing.push(entry.name)
        } else if (r.fingerprint !== entry.fingerprint) {
          drifted.push(entry.name)
        } else {
          declared.push(r)
        }
      }
      return Object.freeze({
        declared: Object.freeze(declared),
        webSearch,
        drifted: Object.freeze(drifted),
        missing: Object.freeze(missing),
      })
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
