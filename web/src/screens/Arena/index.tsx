import { useId, useMemo, useState } from 'react'
import { Link, Redirect, useLocation } from 'wouter'
import { useBeam, useCollection, useKeyedProviders, useSession, useSessionState } from '../../app/chat.tsx'
import { needsKey, useModelChoices } from '../../app/providers.tsx'
import { chatPath, paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import { modelKey, standings } from '../../core/compare/elo.ts'
import type { ArenaWinner } from '../../core/contracts/extras.ts'
import type { Id, ModelRef } from '../../core/contracts/workspace.ts'
import { formatNumber } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import chat from '../../ui/chat/Chat.module.css'
import { CandidateCard } from '../../ui/compare/Beam.tsx'
import styles from '../../ui/compare/Compare.module.css'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { ScrollTable } from '../../ui/stats/ScrollTable.tsx'

/*
 * The Arena: two models drawn from the user's own answer one message without their names, the user votes, and the
 * votes (stored encrypted in the workspace, `arenaVotes`) rank the models by Elo (core/compare/elo.ts). Each round is
 * an ordinary conversation whose two answers are siblings, so it can be continued in the chat afterwards.
 */

/** A uniformly random index below `n`, from the platform's cryptographic generator. */
function randomBelow(n: number): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return (buf[0] as number) % n
}

/** Two distinct models of `pool` in random order (which one is "Answer 1" is random too). */
function drawPair(pool: readonly ModelRef[]): [ModelRef, ModelRef] | null {
  if (pool.length < 2) return null
  const first = randomBelow(pool.length)
  let second = randomBelow(pool.length - 1)
  if (second >= first) second++
  return [pool[first] as ModelRef, pool[second] as ModelRef]
}

export default function ArenaScreen() {
  const t = useT()
  const state = useSessionState()
  const { status } = useVault()
  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status !== 'open') {
    return (
      <Screen title={t('compare.arenaTitle')}>
        <p className={chat.loading} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }
  return <Arena />
}

function Arena() {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const [, navigate] = useLocation()
  const choices = useModelChoices()
  const keyed = useKeyedProviders()
  const pool = useMemo(
    () =>
      choices
        .filter((c) => !(needsKey(c.provider) && keyed !== null && !keyed.has(c.provider.id)))
        .map((c) => c.model.ref),
    [choices, keyed],
  )
  const [prompt, setPrompt] = useState('')
  const [round, setRound] = useState<{ conversation: Id; prompt: string } | null>(null)
  const [voted, setVoted] = useState<ArenaWinner | null>(null)
  const [sending, setSending] = useState(false)
  const beam = useBeam(round?.conversation ?? null)
  const promptId = useId()

  if (session === null) return null
  const nameOf = (ref: ModelRef) => session.resolveModel(ref)?.name ?? ref.id

  const start = async () => {
    const pair = drawPair(pool)
    const text = prompt.trim()
    if (pair === null || text === '') return
    setSending(true)
    const conversation = session.workspace.conversations.create({ model: pair[0] })
    try {
      await session.beam.start(conversation, [{ type: 'text', text }], pair, { mode: 'arena' })
      setRound({ conversation, prompt: text })
      setVoted(null)
      setPrompt('')
    } catch {
      session.workspace.conversations.trash(conversation)
      toast(t('compare.arenaFailed'))
    } finally {
      setSending(false)
    }
  }

  const [one, two] = beam?.candidates ?? []
  const complete =
    one !== undefined && two !== undefined && beam !== null && !beam.running && one.status !== 'streaming'

  const vote = (winner: ArenaWinner) => {
    if (round === null || one === undefined || two === undefined) return
    session.workspace
      .collection('arenaVotes')
      .create({ a: one.model, b: two.model, winner, conversation: round.conversation })
    setVoted(winner)
    toast(t('compare.arenaVoted'))
  }

  const finish = async (open: boolean) => {
    if (round === null) return
    const winner = voted === 'b' ? two : one
    if (winner !== undefined) {
      await session.beam.pick(round.conversation, winner.messageId)
      session.workspace.conversations.update(round.conversation, { model: winner.model })
    }
    session.beam.close(round.conversation)
    setRound(null)
    setVoted(null)
    if (open) navigate(chatPath(round.conversation))
  }

  return (
    <Screen title={t('compare.arenaTitle')} subtitle={t('compare.arenaLead')}>
      <div className={styles.arena}>
        {pool.length < 2 ? (
          <EmptyState
            title={t('compare.arenaTitle')}
            body={t('compare.arenaNeedsTwo')}
            action={
              <Link href={paths.providers} className={buttonClass({ variant: 'primary' })}>
                {t('compare.arenaAddModels')}
              </Link>
            }
          />
        ) : round === null ? (
          <form
            className={styles.promptForm}
            onSubmit={(e) => {
              e.preventDefault()
              void start()
            }}
          >
            <label htmlFor={promptId} className={styles.label}>
              {t('compare.arenaPrompt')}
            </label>
            <textarea
              id={promptId}
              className={styles.textarea}
              value={prompt}
              placeholder={t('compare.arenaPromptPlaceholder')}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <p className={chat.muted}>{t('compare.arenaPoolHint')}</p>
            <div>
              <Button type="submit" variant="primary" loading={sending} disabled={prompt.trim() === ''}>
                {t('compare.arenaSend')}
              </Button>
            </div>
          </form>
        ) : (
          <section className={styles.section} aria-label={t('compare.arenaRound')}>
            <p className={styles.userPrompt}>{round.prompt}</p>
            <div className={styles.columns} data-count={2}>
              {[one, two].map(
                (c, i) =>
                  c !== undefined && (
                    <CandidateCard
                      key={c.messageId}
                      candidate={c}
                      label={
                        voted === null
                          ? t('compare.beamAnswerNumber', { index: i + 1 })
                          : t('compare.beamAnswerFrom', { model: nameOf(c.model) })
                      }
                    />
                  ),
              )}
            </div>
            {voted === null ? (
              <div className={styles.vote}>
                <h2 className={styles.sectionTitle}>{t('compare.arenaVoteTitle')}</h2>
                {!complete && (
                  <p className={chat.muted} role="status">
                    {t('compare.arenaVoteWaiting')}
                  </p>
                )}
                <div className={styles.voteButtons}>
                  <Button variant="secondary" disabled={!complete} onClick={() => vote('a')}>
                    {t('compare.arenaVoteA')}
                  </Button>
                  <Button variant="secondary" disabled={!complete} onClick={() => vote('b')}>
                    {t('compare.arenaVoteB')}
                  </Button>
                  <Button variant="plain" disabled={!complete} onClick={() => vote('tie')}>
                    {t('compare.arenaVoteTie')}
                  </Button>
                  <Button variant="plain" disabled={!complete} onClick={() => vote('bad')}>
                    {t('compare.arenaVoteBad')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className={styles.vote}>
                {one !== undefined && two !== undefined && (
                  <p role="status">{t('compare.arenaRevealed', { a: nameOf(one.model), b: nameOf(two.model) })}</p>
                )}
                <div className={chat.sheetActions}>
                  <Button variant="primary" onClick={() => void finish(false)}>
                    {t('compare.arenaNext')}
                  </Button>
                  <Button variant="secondary" onClick={() => void finish(true)}>
                    {t('compare.arenaContinue')}
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}
        <Leaderboard />
      </div>
    </Screen>
  )
}

function Leaderboard() {
  const t = useT()
  const locale = useLocale()
  const session = useSession()
  const votes = useCollection('arenaVotes')
  const table = useMemo(() => standings(votes), [votes])
  const headingId = useId()
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {t('compare.arenaLeaderboard')}
      </h2>
      {table.length === 0 ? (
        <p className={chat.muted}>{t('compare.arenaLeaderboardEmpty')}</p>
      ) : (
        <>
          <ScrollTable className={styles.tableWrap} labelledBy={headingId}>
            <table className={styles.table} aria-labelledby={headingId}>
              <thead>
                <tr>
                  <th scope="col" className={styles.num}>
                    {t('compare.arenaColRank')}
                  </th>
                  <th scope="col">{t('compare.arenaColModel')}</th>
                  <th scope="col" className={styles.num}>
                    {t('compare.arenaColRating')}
                  </th>
                  <th scope="col">{t('compare.arenaColRecord')}</th>
                </tr>
              </thead>
              <tbody>
                {table.map((s, i) => (
                  <tr key={s.key} data-model={modelKey(s.model)}>
                    <td className={styles.num}>{formatNumber(locale, i + 1, 0)}</td>
                    <th scope="row">{session?.resolveModel(s.model)?.name ?? s.model.id}</th>
                    <td className={styles.num}>{formatNumber(locale, Math.round(s.rating), 0)}</td>
                    <td>
                      {t('compare.arenaRecord', { wins: s.wins, losses: s.losses, ties: s.ties })}
                      <span className="sr-only"> · {t('compare.arenaGames', { count: s.games })}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTable>
          <p className={chat.muted}>{t('compare.arenaRatingNote')}</p>
        </>
      )}
    </section>
  )
}
