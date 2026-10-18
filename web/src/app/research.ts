import type { Capabilities, Effort, FetchLike, ModelDescriptor } from '../core/contracts/ai.ts'
import type { ResearchBackendId, ResearchDepth, ResearchHistory } from '../core/contracts/research.ts'
import type { Tool } from '../core/contracts/tools.ts'
import type {
  BlobPort,
  Conversation,
  Id,
  Message,
  ModelRef,
  Part,
  Settings,
  Workspace,
} from '../core/contracts/workspace.ts'
import { BACKENDS } from '../core/research/backends.ts'
import { researchHistory } from '../core/research/history.ts'
import { researchDepth } from '../core/research/plan.ts'
import { researchTools } from '../core/research/tools.ts'
import { request } from '../security/net.ts'
import { readPref } from './prefs.ts'

/*
 * Deep research on this page's side: the research tools of the session (core/research/tools.ts) over
 * web/src/security/net.ts, the branch they read their history from, and the effort that sets their depth. Loaded with
 * the session, after unlock.
 *
 * Invariants:
 * - The search backends are fetched with purpose `research` (their hosts are in spec/network-allowlist.json), the
 *   pages with purpose `tool`, both through net.ts: no cookie, no credential, no referrer.
 * - The history is read from the committed branch, with its large parts substituted from their blobs, so what the
 *   tools allow and number is what the conversation holds, on every device.
 */

const fetchWith =
  (purpose: 'research' | 'tool'): FetchLike =>
  (input, init) =>
    request(input instanceof Request ? input.url : input, { ...init, purpose })

/** The backends the user turned on (app/prefs.ts `researchSources`), or undefined for the default set. */
export function enabledBackends(raw = readPref('researchSources')): readonly ResearchBackendId[] | undefined {
  if (raw === '') return undefined
  const known = new Set<string>(BACKENDS.map((b) => b.id))
  const ids = raw.split(',').filter((id): id is ResearchBackendId => known.has(id))
  return ids.length === 0 ? undefined : ids
}

/** A path's parts with every `ref` part replaced by the part its blob holds (one this device lacks is dropped). */
export async function substitutedPath(path: readonly Message[], blobs: BlobPort): Promise<Message[]> {
  const out: Message[] = []
  for (const message of path) {
    if (!message.parts.some((p) => p.type === 'ref')) {
      out.push(message)
      continue
    }
    const parts: Part[] = []
    for (const part of message.parts) {
      if (part.type !== 'ref') {
        parts.push(part)
        continue
      }
      const bytes = await blobs.get(part.blob).catch(() => null)
      if (bytes === null) continue
      try {
        parts.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Part)
      } catch {
        // A damaged part is left out, as a missing one is.
      }
    }
    out.push({ ...message, parts })
  }
  return out
}

export interface ResearchSessionDeps {
  readonly workspace: Workspace
  readonly blobs: BlobPort
  readonly resolveModel: (ref: ModelRef) => ModelDescriptor | null
  readonly pickEffort: (
    conversation: Pick<Conversation, 'effort'>,
    settings: Pick<Settings, 'defaultEffort'>,
    capabilities: Capabilities,
  ) => Effort | null
}

/** The effort a conversation's next turn runs at, as the controller picks it. */
export function effortOf(deps: ResearchSessionDeps, conversationId: Id): Effort | null {
  const conversation = deps.workspace.conversations.get(conversationId)
  const model = conversation?.model == null ? null : deps.resolveModel(conversation.model)
  if (conversation === undefined || model === null) return null
  return deps.pickEffort(
    conversation,
    { defaultEffort: deps.workspace.settings.get('defaultEffort') },
    model.capabilities,
  )
}

/** The research tools of a session. */
export function sessionResearchTools(deps: ResearchSessionDeps): Tool[] {
  const history = async (conversationId: Id): Promise<ResearchHistory> => {
    const thread = await deps.workspace.thread(conversationId)
    return researchHistory(await substitutedPath(thread.path(), deps.blobs))
  }
  const depth = (conversationId: Id): ResearchDepth => researchDepth(effortOf(deps, conversationId))
  return [
    ...researchTools({
      fetchBackend: fetchWith('research'),
      fetchPage: fetchWith('tool'),
      history,
      depth,
      enabled: () => enabledBackends() ?? BACKENDS.filter((b) => b.byDefault).map((b) => b.id),
    }),
  ]
}
