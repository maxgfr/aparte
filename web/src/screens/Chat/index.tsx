import { ChevronLeft, MoreHorizontal, SquarePen } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, Redirect, useLocation } from 'wouter'
import {
  useBeam,
  useCollection,
  useConversation,
  useImageTurn,
  useKeyedProviders,
  useProviders,
  useRegisteredTools,
  useSession,
  useSessionState,
  useSetting,
  useStream,
  useThread,
} from '../../app/chat.tsx'
import { needsKey, useModelChoices } from '../../app/providers.tsx'
import { enabledBackends } from '../../app/research.ts'
import { chatPath, paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import { mediaOffer } from '../../core/ai/mediaOffer.ts'
import type { Effort } from '../../core/contracts/ai.ts'
import type { StreamState } from '../../core/contracts/chat.ts'
import { InvalidInputError, InvalidStateError } from '../../core/contracts/crypto.ts'
import { RESEARCH_READ, RESEARCH_SEARCH } from '../../core/contracts/research.ts'
import { SKILL_TOOL } from '../../core/contracts/skills.ts'
import { type ApprovalDecision, WEB_SEARCH } from '../../core/contracts/tools.ts'
import type { Id, Message, ModelRef, Part } from '../../core/contracts/workspace.ts'
import { BACKENDS } from '../../core/research/backends.ts'
import { researchDepth, researchPart } from '../../core/research/plan.ts'
import { offeredSkills, skillsPart } from '../../core/skills/context.ts'
import { useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'
import { Composer, type ImageControls } from '../../ui/chat/Composer.tsx'
import { ConversationActions } from '../../ui/chat/ConversationList.tsx'
import { ImageTurnRow, type MessageActions, MessageRow, StreamingAnswer } from '../../ui/chat/Messages.tsx'
import { ToolsButton } from '../../ui/chat/Tools.tsx'
import { isResearchMessage, visibleMessages, windowOf } from '../../ui/chat/view.ts'
import { BeamButton, BeamPanel, useBeamSelection } from '../../ui/compare/Beam.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { AttachButton } from '../../ui/knowledge/AttachButton.tsx'
import { ResearchButton, ResearchProgressPanel, useResearchProgress } from '../../ui/research/Research.tsx'
import { QuickRepliesBar, RoleplayButton, useRoleplay } from '../../ui/roleplay/RoleplayButton.tsx'
import { ProtectHint } from '../../ui/shell/ProtectHint.tsx'

/*
 * The chat screen: one conversation's active branch, the answer streaming into it, and the composer. `/chat` is a new
 * chat: nothing is stored until its first message, which creates the conversation with the model, effort and system
 * prompt chosen here.
 */

/** The tools Deep research adds to a chat: its own switch controls them, not the Tools sheet. */
const RESEARCH_TOOLS: ReadonlySet<string> = new Set([RESEARCH_SEARCH, RESEARCH_READ])

/** An MCP tool that searches, which a Deep research chat may offer the model for searching. */
const SEARCHING = /search|find|lookup|query/i

/** Distance from the bottom under which the thread keeps following a streaming answer. */
const STICK_PX = 160

function nearBottom(): boolean {
  const doc = document.documentElement
  return doc.scrollHeight - (scrollY + innerHeight) < STICK_PX
}

/** Follows the end of the thread while the reader is there; a reader who scrolled up is left alone. */
function useFollow(trigger: string) {
  const stick = useRef(true)
  useEffect(() => {
    const onScroll = () => {
      stick.current = nearBottom()
    }
    addEventListener('scroll', onScroll, { passive: true })
    return () => removeEventListener('scroll', onScroll)
  }, [])
  // Frames, not every delta: the scroll follows at most once per frame.
  const frame = useRef(0)
  const seen = useRef<string | null>(null)
  useLayoutEffect(() => {
    // Only a change of the thread's content moves the scroll, not any render.
    if (seen.current === trigger) return
    seen.current = trigger
    if (!stick.current) return
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => scrollTo({ top: document.documentElement.scrollHeight }))
  }, [trigger])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  return () => {
    stick.current = true
  }
}

/**
 * Keeps what scrolls into view in the thread clear of the sticky header and composer dock, which on a phone can cover
 * half the screen: their heights go to `--sticky-top` and `--sticky-bottom` on <html>, which the scroll margin of the
 * thread's content adds (Chat.module.css).
 */
function useStickyClearance(): {
  readonly header: (el: HTMLElement | null) => void
  readonly dock: (el: HTMLElement | null) => void
} {
  return useMemo(() => {
    const track = (property: string) => {
      let observer: ResizeObserver | null = null
      return (el: HTMLElement | null) => {
        observer?.disconnect()
        observer = null
        const root = document.documentElement
        if (el === null) {
          root.style.removeProperty(property)
          return
        }
        const write = () => root.style.setProperty(property, `${Math.ceil(el.getBoundingClientRect().height)}px`)
        write()
        if (typeof ResizeObserver === 'undefined') return
        observer = new ResizeObserver(write)
        observer.observe(el)
      }
    }
    return { header: track('--sticky-top'), dock: track('--sticky-bottom') }
  }, [])
}

/**
 * A stream's parts change at every delta; React renders them at most once per animation frame. A stream that starts
 * or ends shows at once, so its answer appears together with the message that started it.
 */
function useFrameThrottled(value: StreamState | null): StreamState | null {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  latest.current = value
  const pending = useRef(0)
  useEffect(() => {
    if (value === null) {
      cancelAnimationFrame(pending.current)
      pending.current = 0
      setShown(value)
      return
    }
    if (pending.current !== 0) return
    pending.current = requestAnimationFrame(() => {
      pending.current = 0
      setShown(latest.current)
    })
  }, [value])
  useEffect(() => () => cancelAnimationFrame(pending.current), [])
  if (value === null || shown === null || shown.messageId !== value.messageId) return value
  return shown
}

export default function ChatScreen({ params }: { params?: { id?: string } }) {
  const t = useT()
  const state = useSessionState()
  const { status } = useVault()
  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status === 'failed') {
    return (
      <div role="alert">
        <EmptyState
          title={t('chat.sessionFailedTitle')}
          body={t('chat.sessionFailedBody')}
          action={
            <Button variant="primary" onClick={() => location.reload()}>
              {t('chat.retry')}
            </Button>
          }
        />
      </div>
    )
  }
  if (state.status !== 'open') {
    return (
      <p className={styles.loading} role="status">
        {t('chat.sessionOpening')}
      </p>
    )
  }
  const id = params?.id === undefined ? null : decodeURIComponent(params.id)
  return <ChatView key={id ?? 'new'} id={id} />
}

function ChatView({ id }: { id: Id | null }) {
  const t = useT()
  const toast = useToast()
  const [, navigate] = useLocation()
  const session = useSession()
  const conversation = useConversation(id)
  const thread = useThread(id)
  const rawStream = useStream(id)
  const stream = useFrameThrottled(rawStream)
  const keyed = useKeyedProviders()
  const choices = useModelChoices()
  const providers = useProviders()
  const imageTurn = useImageTurn(id)
  const imageSetting = useSetting('imageModel')
  const defaultModel = useSetting('defaultModel')
  const defaultEffort = useSetting('defaultEffort')
  const defaultSystem = useSetting('defaultSystem')
  const [menu, setMenu] = useState(false)
  const [earlier, setEarlier] = useState(0)
  const beam = useBeam(id)
  // Beam: with two models or more chosen, the next message goes to all of them (core/compare/beam.ts).
  const [beamModels, setBeamModels] = useBeamSelection()
  // Characters, lorebooks and the Author's Note (ui/roleplay): what they add is committed with the user message.
  const roleplay = useRoleplay(id)
  const roleplayRef = useRef(roleplay)
  roleplayRef.current = roleplay

  // A new chat keeps its choices here until its first message creates the conversation.
  const [draft, setDraft] = useState<{
    model: ModelRef | null
    effort: Effort | null
    system: string | null
    /** Tool names chosen for the new chat; null: every registered tool but the sandbox ones, which are opt-in. */
    tools: readonly string[] | null
    webSearch: boolean
    /** Knowledge bases attached to the new chat. */
    knowledge: readonly Id[]
  }>({ model: null, effort: null, system: null, tools: null, webSearch: false, knowledge: [] })
  const [retrieving, setRetrieving] = useState(false)
  const registered = useRegisteredTools()
  const installedSkills = useCollection('skills')
  const offered = useMemo(() => offeredSkills(installedSkills), [installedSkills])
  // Deep research in a chat that has its tools: on for every message unless switched off for the next ones.
  const [researchTurns, setResearchTurns] = useState(true)
  const fallbackModel = defaultModel ?? choices[0]?.model.ref ?? null
  const modelRef = conversation?.model ?? (id === null ? (draft.model ?? fallbackModel) : null)
  const model = modelRef === null || session === null ? null : session.resolveModel(modelRef)
  const effortSource = conversation?.effort ?? (id === null ? draft.effort : null)
  const effort =
    model === null || session === null
      ? null
      : session.modules.request.pickEffort(
          { effort: effortSource },
          { defaultEffort: defaultEffort ?? null },
          model.capabilities,
        )
  const system = conversation?.system ?? draft.system ?? defaultSystem ?? ''
  const started = conversation?.startedAt !== undefined
  const knowledgeIds = conversation !== undefined ? (conversation.knowledge ?? []) : draft.knowledge

  // The chat's tool set: the draft's until a conversation exists, then the conversation's own snapshot.
  const toolNames = useMemo(() => {
    if (conversation !== undefined)
      return new Set(conversation.tools.filter((e) => e.source !== 'provider').map((e) => e.name))
    // A new chat starts with the built-in tools; the sandboxes are opt-in, research has its own switch, and the Skills
    // tool comes only when a skill is there to load.
    const defaults = registered.filter(
      (r) =>
        r.tool.source !== 'sandbox' &&
        !RESEARCH_TOOLS.has(r.tool.name) &&
        (r.tool.name !== SKILL_TOOL || offered.length > 0),
    )
    return new Set(draft.tools ?? defaults.map((r) => r.tool.name))
  }, [conversation, draft.tools, registered, offered.length])
  const webSearch =
    conversation !== undefined
      ? conversation.tools.some((e) => e.source === 'provider' && e.name === WEB_SEARCH)
      : draft.webSearch
  // Cheap, and read again on every render: a registry change re-renders through useRegisteredTools.
  const resolved = conversation === undefined || session === null ? null : session.tools.resolve(conversation.tools)
  const declares = (name: string) =>
    resolved === null ? toolNames.has(name) : resolved.declared.some((r) => r.tool.name === name)
  // Deep research: its tools are in the chat's set (fixed by the first message), and it is on for the next message.
  const researchTools = toolNames.has(RESEARCH_SEARCH) && toolNames.has(RESEARCH_READ)
  const researchOn = researchTools && (!started || researchTurns)
  const depth = researchDepth(effort)
  const searchTools = registered.filter((r) => r.tool.source === 'mcp' && SEARCHING.test(r.tool.name))
  const sheetSelected = useMemo(() => new Set([...toolNames].filter((n) => !RESEARCH_TOOLS.has(n))), [toolNames])

  const path = thread.status === 'ready' ? thread.path : []
  // A regenerated answer streams as a sibling of the one on screen: the branch shows up to its parent meanwhile.
  const streamParent = rawStream?.parentId ?? null
  // While answers are compared, the branch shows up to the question they answer; the comparison takes the rest.
  const beamUser = beam?.userMessageId ?? null
  const visible = useMemo(() => {
    const all = visibleMessages(path)
    const cut = beamUser ?? streamParent
    if (cut === null) return all
    const at = all.findIndex((m) => m.id === cut)
    return at < 0 ? all : all.slice(0, at + 1)
  }, [path, streamParent, beamUser])
  const { shown, hidden } = windowOf(visible, earlier)
  const treeSize = thread.status === 'ready' ? thread.thread.all().length : 0
  let streamed = 0
  for (const part of stream?.parts ?? [])
    if (part.type === 'text' || part.type === 'reasoning') streamed += part.text.length
  const calls = stream?.tools.map((c) => c.status).join(',') ?? ''
  let beamed = 0
  for (const c of beam?.candidates ?? [])
    for (const part of c.parts) if (part.type === 'text') beamed += part.text.length
  const follow = useFollow(
    `${visible.length}|${stream?.parts.length ?? 0}|${streamed}|${calls}|${beamed}|${imageTurn?.messageId ?? ''}`,
  )
  const sticky = useStickyClearance()
  const busy = rawStream !== null || beam?.running === true || imageTurn !== null
  const research = useResearchProgress(path, rawStream)

  // Esc stops the answer from anywhere on the screen, unless a dialog is open (Esc closes it instead).
  useEffect(() => {
    if (id === null || rawStream === null || session === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return
      session.chat.stop(id)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [id, rawStream, session])

  const explain = useCallback(
    (error: unknown) => {
      if (error instanceof InvalidStateError && /lock/i.test(error.message)) toast(t('chat.sendFailedLocking'))
      else if (error instanceof InvalidStateError) toast(t('chat.sendFailedNoModel'))
      else if (error instanceof InvalidInputError) toast(t('chat.sendFailed'))
      else toast(t('chat.sendFailed'))
    },
    [toast, t],
  )

  /** The conversation a turn goes to: this one, or a new one created with the choices of the new chat. */
  const conversationFor = async (): Promise<{ target: Id; created: boolean } | null> => {
    if (session === null) return null
    if (id !== null) return { target: id, created: false }
    const tools = await session.tools.snapshot([...toolNames], { webSearch })
    const system = roleplay.draftSystem() ?? draft.system
    const target = session.workspace.conversations.create({
      model: modelRef,
      effort: draft.effort,
      tools,
      ...(system === null ? {} : { system }),
      ...(draft.knowledge.length === 0 ? {} : { knowledge: draft.knowledge }),
    })
    roleplay.commitDraft(target)
    return { target, created: true }
  }

  // Image models of the providers that have their key here (or need none), in the providers' order.
  const imageModels = useMemo(() => {
    const out: { ref: ModelRef; label: string }[] = []
    for (const p of providers) {
      if (needsKey(p) && keyed !== null && !keyed.has(p.id)) continue
      for (const modelId of mediaOffer(p).imageModels)
        out.push({ ref: { provider: p.id, id: modelId }, label: `${modelId} · ${p.label}` })
    }
    return out
  }, [providers, keyed])
  const imageModel =
    imageModels.find(
      (m) => imageSetting !== null && m.ref.provider === imageSetting.provider && m.ref.id === imageSetting.id,
    )?.ref ??
    imageModels[0]?.ref ??
    null

  const onCreateImage = async (prompt: string): Promise<boolean> => {
    if (session === null || imageModel === null) return false
    const at = await conversationFor()
    if (at === null) return false
    const run = session.images.run(at.target, prompt, imageModel)
    // The turn has committed the prompt by the time it shows as running: the new chat can open.
    run.then(
      () => undefined,
      (error: unknown) => {
        if (at.created && session.workspace.conversations.get(at.target)?.startedAt === undefined)
          session.workspace.conversations.trash(at.target)
        if (error instanceof InvalidStateError && /lock/i.test(error.message)) toast(t('chat.sendFailedLocking'))
        else toast(t('media.imageFailed'))
      },
    )
    if (at.created) navigate(chatPath(at.target), { replace: true })
    follow()
    return true
  }

  const imageControls: ImageControls | undefined =
    imageModels.length === 0
      ? undefined
      : {
          models: imageModels,
          model: imageModel,
          onModel: (ref) => session?.workspace.settings.set('imageModel', ref),
          busy: imageTurn !== null,
          onCreate: onCreateImage,
          onStop: () => id !== null && session?.images.stop(id),
        }

  /**
   * The parts of a user message with the best passages of the chat's knowledge bases before its text (a `knowledge`
   * part: the context goes into the user turn, never into the frozen system prompt). Without a match, or when the
   * bases cannot be searched now, the message goes as it is.
   */
  const withKnowledge = useCallback(
    async (parts: readonly Part[], bases: readonly Id[]): Promise<readonly Part[]> => {
      if (session === null || bases.length === 0) return parts
      const query = parts
        .flatMap((p) => (p.type === 'text' ? [p.text] : []))
        .join('\n')
        .trim()
      if (query === '') return parts
      setRetrieving(true)
      try {
        const part = await session.knowledge.context(bases, query)
        if (part === null) return parts
        const at = parts.findIndex((p) => p.type === 'text')
        return at < 0 ? [...parts, part] : [...parts.slice(0, at), part, ...parts.slice(at)]
      } catch {
        return parts
      } finally {
        setRetrieving(false)
      }
    },
    [session],
  )

  /**
   * What the app adds to a user message for the model, after the user's own parts: the list of available skills when
   * the chat has the Skills tool and the list changed since the branch last carried it, and the Deep research playbook
   * when research is on. Both are injected text parts of this message: the frozen prefix is never touched.
   */
  const withAgentContext = (parts: readonly Part[], branch: readonly Message[], researching: boolean): Part[] => {
    const out = [...parts]
    if (declares(SKILL_TOOL)) {
      const list = skillsPart(branch, offered)
      if (list !== null) out.unshift(list)
    }
    if (researching) {
      const on = new Set(enabledBackends() ?? BACKENDS.filter((b) => b.byDefault).map((b) => b.id))
      out.push(
        researchPart({
          depth,
          backends: BACKENDS.filter((b) => on.has(b.id)),
          webSearch: webSearch && model?.capabilities.webSearch != null,
          searchTools: searchTools.filter((r) => declares(r.tool.name)).map((r) => r.tool.name),
        }),
      )
    }
    return out
  }

  /**
   * Starting Deep research allows its two tools for this chat (stored like any "for this chat" approval): they read
   * only what this chat's searches found, so a page cannot steer them. Every other tool still asks.
   */
  const allowResearch = (conversationId: Id) => {
    if (session === null) return
    for (const name of RESEARCH_TOOLS) {
      const tool = session.tools.get(name)
      if (tool === undefined) continue
      const held = session.workspace.toolApprovals.get(tool.approvalKey, conversationId)
      if (held?.fingerprint === tool.fingerprint) continue
      session.workspace.toolApprovals.grant({
        approvalKey: tool.approvalKey,
        fingerprint: tool.fingerprint,
        conversation: conversationId,
      })
    }
  }

  const onSend = async (input: readonly Part[]): Promise<boolean> => {
    if (session === null) return false
    if (modelRef === null || model === null) {
      toast(t('chat.sendFailedNoModel'))
      return false
    }
    const provider = session.workspace.providers.get(modelRef.provider)
    if (provider !== undefined && needsKey(provider) && keyed !== null && !keyed.has(provider.id)) {
      toast(t('chat.sendFailedNoKey', { provider: provider.label }))
      return false
    }
    // Answers being compared finish first: a message sent now would branch from an answer not yet chosen.
    if (beam?.running === true) {
      toast(t('compare.beamBusy'))
      return false
    }
    let parts = await withKnowledge(input, knowledgeIds)
    let target = id
    let created = false
    if (target === null) {
      const tools = await session.tools.snapshot([...toolNames], { webSearch })
      const system = roleplay.draftSystem() ?? draft.system
      target = session.workspace.conversations.create({
        model: modelRef,
        effort: draft.effort,
        tools,
        ...(system === null ? {} : { system }),
        ...(draft.knowledge.length === 0 ? {} : { knowledge: draft.knowledge }),
      })
      roleplay.commitDraft(target)
      created = true
    }
    try {
      parts = await roleplay.prepare(target, parts)
      parts = withAgentContext(parts, thread.status === 'ready' && !created ? thread.path : [], researchOn)
      if (researchOn) allowResearch(target)
      if (beamModels.length >= 2) {
        if (session.chat.stream(target) !== null) {
          toast(t('chat.sendFailed'))
          return false
        }
        await session.beam.start(target, parts, beamModels)
      } else {
        const turn = await session.chat.send(target, parts)
        turn.done.catch(() => undefined)
      }
      if (created) navigate(chatPath(target), { replace: true })
      follow()
      return true
    } catch (error) {
      // Nothing was written for the turn: a chat created for it goes away again.
      if (created) session.workspace.conversations.trash(target)
      explain(error)
      return false
    }
  }

  // The tree object is stable while the conversation is open, so the actions (and every memoised row) are too.
  const tree = thread.status === 'ready' ? thread.thread : null
  const actions = useMemo<MessageActions>(() => {
    if (session === null || id === null || tree === null) return { busy: true }
    return {
      busy,
      onEdit: async (messageId, input) => {
        try {
          // An edited message is a new message: it gets the passages of its own text.
          const parts = await withKnowledge(input, session.workspace.conversations.get(id)?.knowledge ?? [])
          const original = tree.get(messageId)
          const parent = original?.parent ?? null
          const prepared = await roleplayRef.current.prepare(id, parts, parent)
          // The new version carries what the original did: the research playbook, the skills list of its branch.
          const researching = original !== undefined && isResearchMessage(original.parts)
          const branch = parent === null ? [] : tree.path(parent)
          await session.chat.edit(id, messageId, contextRef.current(prepared, branch, researching))
        } catch (error) {
          explain(error)
        }
      },
      onRegenerate: (messageId) => {
        session.chat.regenerate(id, messageId).catch(explain)
      },
      onBranch: (messageId) => {
        tree.setLeaf(tree.descend(messageId))
      },
      onApprove: (callId: string, decision: ApprovalDecision) => {
        try {
          session.chat.approve(id, callId, decision)
        } catch (error) {
          explain(error)
        }
      },
    }
  }, [session, id, tree, busy, explain, withKnowledge])
  const contextRef = useRef(withAgentContext)
  contextRef.current = withAgentContext

  // Whether the model takes tools is the catalog's say; the user may correct it for a model the catalog does not know.
  const provider =
    modelRef === null || session === null ? undefined : session.workspace.providers.get(modelRef.provider)
  const toolsOverride = modelRef === null ? undefined : provider?.overrides?.[modelRef.id]?.tools
  const modelTools =
    model === null ||
    provider === undefined ||
    modelRef === null ||
    (model.capabilities.tools && toolsOverride === undefined)
      ? null
      : {
          checked: model.capabilities.tools,
          onChange: (on: boolean) => {
            const overrides = provider.overrides ?? {}
            session?.workspace.providers.update(provider.id, {
              overrides: { ...overrides, [modelRef.id]: { ...overrides[modelRef.id], tools: on } },
            })
          },
        }

  /** Changes the tool set before the first message: the draft's, or a conversation's that has not started. */
  const setTools = (names: ReadonlySet<string>, search: boolean) => {
    if (session === null || started) return
    if (id === null) {
      setDraft((d) => ({ ...d, tools: [...names], webSearch: search }))
      return
    }
    void session.tools.snapshot([...names], { webSearch: search }).then((tools) => {
      if (session.workspace.conversations.get(id)?.startedAt === undefined)
        session.workspace.conversations.update(id, { tools })
    })
  }

  const onModel = (ref: ModelRef) => {
    if (session === null) return
    if (id !== null) session.workspace.conversations.update(id, { model: ref })
    else setDraft((d) => ({ ...d, model: ref }))
    // The last model picked is where the next new chat starts.
    session.workspace.settings.set('defaultModel', ref)
  }
  const onEffort = (next: Effort) => {
    if (session === null) return
    if (id !== null) session.workspace.conversations.update(id, { effort: next })
    else setDraft((d) => ({ ...d, effort: next }))
  }
  const onSystem = async (text: string) => {
    if (session === null) return
    if (id === null) setDraft((d) => ({ ...d, system: text }))
    else if (!started) session.workspace.conversations.update(id, { system: text })
    else await session.chat.appendSystem(id, text)
  }

  if (
    id !== null &&
    (thread.status === 'missing' || (conversation !== undefined && conversation.deletedAt !== undefined))
  ) {
    return (
      <EmptyState
        title={t('chat.threadMissing')}
        body={t('chat.threadMissingBody')}
        action={
          <Link href={paths.chat} className={buttonClass({ variant: 'primary' })}>
            {t('chat.navNewChat')}
          </Link>
        }
      />
    )
  }

  const title = conversation?.title || t('chat.untitled')
  const empty = visible.length === 0 && stream === null
  const noModels = choices.length === 0

  return (
    <div className={styles.chat}>
      <header className={styles.chatHeader} ref={sticky.header}>
        <Link href={paths.conversations} className={styles.headerBack}>
          <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
          <span>{t('chat.backToChats')}</span>
        </Link>
        <h1 className={styles.chatTitle}>{title}</h1>
        <div className={styles.headerActions}>
          <Link href={paths.about} className={styles.privacyChip}>
            {t('chat.privacyLocal')}
          </Link>
          {conversation !== undefined && (
            <IconButton icon={MoreHorizontal} label={t('chat.more')} onClick={() => setMenu(true)} />
          )}
          <Link
            href={paths.chat}
            className={styles.headerIcon}
            aria-label={t('chat.navNewChat')}
            title={t('chat.navNewChat')}
          >
            <SquarePen size={20} strokeWidth={1.75} aria-hidden="true" />
          </Link>
        </div>
      </header>

      <div className={styles.thread}>
        {thread.status === 'loading' && id !== null && (
          <p className={styles.loading} role="status">
            {t('chat.threadLoading')}
          </p>
        )}
        {empty && thread.status !== 'loading' && (
          <div className={styles.empty}>
            <h2 className={styles.emptyTitle}>{noModels ? t('chat.noProviderTitle') : t('chat.emptyTitle')}</h2>
            <p className={styles.emptyBody}>{noModels ? t('chat.noProviderBody') : t('chat.emptyBody')}</p>
            {noModels && (
              <Link href={paths.providers} className={buttonClass({ variant: 'primary' })}>
                {t('chat.noProviderAction')}
              </Link>
            )}
            <ProtectHint />
          </div>
        )}
        {hidden > 0 && (
          <Button variant="plain" onClick={() => setEarlier((n) => n + 1)}>
            {t('chat.showEarlier', { count: hidden })}
          </Button>
        )}
        {thread.status === 'ready' &&
          shown.map((message) => (
            <MessageRow
              key={message.id}
              thread={thread.thread}
              message={message}
              actions={actions}
              treeSize={treeSize}
              live={stream?.phase === 'tools' && stream.parentId === message.id ? stream.tools : undefined}
            />
          ))}
        {beam !== null && id !== null && <BeamPanel conversationId={id} state={beam} />}
        {stream !== null && stream.phase === 'model' && <StreamingAnswer stream={stream} />}
        {retrieving && (
          <p className={styles.caption} role="status" aria-live="polite">
            {t('knowledge.retrieving')}
          </p>
        )}
        {imageTurn !== null && <ImageTurnRow turn={imageTurn} />}
        {research !== null && id !== null && (
          <ResearchProgressPanel progress={research} onStop={() => session?.chat.stop(id)} />
        )}
        {stream !== null && stream.phase === 'tools' && (
          <p className={styles.caption} role="status" aria-live="polite">
            {stream.tools.some((c) => c.status === 'approval') ? t('tools.approvalPending') : t('tools.runningTools')}
          </p>
        )}
      </div>

      <div className={styles.composerDock} ref={sticky.dock}>
        <QuickRepliesBar disabled={beam?.running === true} onSend={(text) => void onSend([{ type: 'text', text }])} />
        <Composer
          modelRef={modelRef}
          model={model}
          onModel={onModel}
          effort={effort}
          onEffort={onEffort}
          system={system}
          systemFrozen={started}
          onSystem={onSystem}
          tools={
            <>
              <ToolsButton
                options={registered
                  .filter((r) => !RESEARCH_TOOLS.has(r.tool.name))
                  .map((r) => ({
                    name: r.tool.name,
                    source: r.tool.source,
                    ...(r.tool.title === undefined ? {} : { title: r.tool.title }),
                    ...(r.tool.origin === undefined ? {} : { origin: r.tool.origin }),
                  }))}
                selected={sheetSelected}
                webSearch={webSearch}
                frozen={started}
                model={model}
                drifted={resolved?.drifted ?? []}
                missing={resolved?.missing ?? []}
                onToggle={(name, on) => {
                  const next = new Set(toolNames)
                  if (on) next.add(name)
                  else next.delete(name)
                  setTools(next, webSearch)
                }}
                onWebSearch={(on) => setTools(toolNames, on)}
                onRevoke={(key) => session?.workspace.toolApprovals.revoke(key, null)}
                modelTools={modelTools}
              />
              <ResearchButton
                on={researchOn}
                unavailable={started && !researchTools}
                model={model}
                depth={depth}
                searchTools={searchTools.map((r) => ({ name: r.tool.name, title: r.tool.title ?? r.tool.name }))}
                selectedSearchTools={toolNames}
                frozen={started}
                onChange={(on) => {
                  if (started) {
                    setResearchTurns(on)
                    return
                  }
                  const next = new Set(toolNames)
                  for (const name of RESEARCH_TOOLS) {
                    if (on) next.add(name)
                    else next.delete(name)
                  }
                  // Research searches with the model's own web search first, where it has one.
                  setTools(next, on ? webSearch || model?.capabilities.webSearch != null : webSearch)
                }}
                onSearchTool={(name, on) => {
                  const next = new Set(toolNames)
                  if (on) next.add(name)
                  else next.delete(name)
                  setTools(next, webSearch)
                }}
              />
              <BeamButton models={beamModels} onChange={setBeamModels} />
              <RoleplayButton roleplay={roleplay} started={started} />
              <AttachButton
                selected={knowledgeIds}
                onChange={(bases) => {
                  if (session === null) return
                  if (id === null) setDraft((d) => ({ ...d, knowledge: bases }))
                  else session.workspace.conversations.update(id, { knowledge: bases })
                }}
              />
            </>
          }
          streaming={rawStream !== null}
          queued={rawStream?.queued ?? 0}
          onSend={onSend}
          onStop={() => {
            if (id === null) return
            session?.chat.stop(id)
            session?.beam.stop(id)
          }}
          image={imageControls}
          takesSharedDraft={id === null}
        />
      </div>

      {conversation !== undefined && (
        <ConversationActions
          conversation={conversation}
          open={menu}
          onClose={() => setMenu(false)}
          onDeleted={() => navigate(paths.conversations, { replace: true })}
        />
      )}
    </div>
  )
}
