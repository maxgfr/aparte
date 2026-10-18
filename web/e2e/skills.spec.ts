import { randomUUID } from 'node:crypto'
import { sandbox } from '../src/i18n/en/sandbox.ts'
import { skills } from '../src/i18n/en/skills.ts'
import {
  allowCall,
  awaitingApproval,
  closeSheet,
  content,
  newChat,
  openTools,
  send,
  settled,
  startChat,
  toolCard,
  toolSwitch,
} from './fixtures/chat-ui.ts'
import { importFromGitHub, openSkills, SkillRepoMock, skillCard } from './fixtures/skills.ts'
import { anthropicText, anthropicToolCalls } from './fixtures/sse.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * Skills from the user's side, against a GitHub repository the test plays: a skill is imported from a public path
 * (unauthenticated requests only), stored encrypted, listed to the model in the user turn, loaded through the `skill`
 * tool without asking (it only reads), and its script runs only through the sandbox's run_js, after the user saw its
 * code and allowed it.
 */

test.use({ netPurposes: ['provider', 'skills'] })

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5' } as const

type AnthropicBlock = { type: string; [k: string]: unknown }
const blocksOf = (body: Record<string, unknown>): AnthropicBlock[] =>
  (body.messages as { content: string | AnthropicBlock[] }[]).flatMap((m) =>
    typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
  )

test('a skill imported from GitHub is loaded on demand and its script runs only in the sandbox, after approval', async ({
  page,
  context,
  providers,
}) => {
  test.setTimeout(240_000)
  const canary = `mean-of-${randomUUID()}`
  const script = `const values = [2, 4, 6]\nconsole.log(${JSON.stringify(canary)})\nreturn values.reduce((a, b) => a + b, 0) / values.length`
  const repo = new SkillRepoMock('acme', 'agent-skills', {
    'README.md': '# Skills of Acme',
    'skills/csv-stats/SKILL.md': [
      '---',
      'name: csv-stats',
      'description: Summarize a list of numbers. Use when the user asks for statistics.',
      'license: MIT',
      'metadata:',
      '  version: 1.2.0',
      '---',
      '# CSV stats',
      '',
      `Run [the script](scripts/stats.js) in the sandbox and report its value. Marker: ${canary}.`,
      '',
    ].join('\n'),
    'skills/csv-stats/scripts/stats.js': script,
    'skills/csv-stats/.hidden/secret.txt': 'never imported',
  })
  await repo.install(context)
  await startChat(page, providers, { ...CLAUDE, key: `sk-ant-api03-${randomUUID()}` })

  await openSkills(page)
  await accessible(page, 'skills, empty')
  await importFromGitHub(page, 'https://github.com/acme/agent-skills/tree/main/skills')
  await expect(page.locator('[data-skill-import="done"]')).toContainText(skills.imported.replace('{count}', '1'))
  const card = skillCard(page, 'csv-stats')
  await expect(card).toContainText('Summarize a list of numbers.')
  await expect(card).toContainText('acme/agent-skills/skills/csv-stats')
  await expect(card.getByRole('switch', { name: skills.enabled })).toBeChecked()
  await accessible(page, 'skills, one installed')
  // Only unauthenticated GETs went to GitHub, and the hidden folder was never fetched.
  expect(repo.problems).toEqual([])
  expect(repo.requests.every((r) => r.startsWith('GET '))).toBe(true)
  expect(repo.requests.some((r) => r.includes('.hidden'))).toBe(false)
  expect(repo.requests.some((r) => r.includes('/scripts/stats.js'))).toBe(true)

  // A new chat offers the Skills tool, on, since a skill is enabled; the sandbox tools stay opt-in.
  await newChat(page, CLAUDE.model)
  const sheet = await openTools(page)
  await expect(toolSwitch(sheet, skills.toolName)).toBeChecked()
  await toolSwitch(sheet, sandbox.name_run_js).check()
  await closeSheet(sheet)

  providers.serve(
    'anthropic',
    anthropicToolCalls([{ id: 'toolu_skill', name: 'skill', input: { name: 'csv-stats' } }], 'Loading the skill.'),
    anthropicToolCalls([{ id: 'toolu_file', name: 'skill', input: { name: 'csv-stats', path: 'scripts/stats.js' } }]),
    anthropicToolCalls([{ id: 'toolu_run', name: 'run_js', input: { code: script } }]),
    anthropicText(['The mean is 4.']),
  )
  await send(page, 'What is the mean of my numbers?')

  // The skill tool only reads: it ran without asking. The script waits for approval with its code in full.
  const run = await awaitingApproval(page, sandbox.name_run_js)
  await expect(run).toContainText('values.reduce')
  await expect(toolCard(page, skills.toolName)).toHaveAttribute('data-tool-status', 'done')
  const generations = providers.generations('anthropic')
  expect(generations).toHaveLength(3)
  // The list of skills went in the user turn, never in the system prompt, and the tool returned the body and files.
  const first = generations[0]?.body as Record<string, unknown>
  expect(JSON.stringify(first.system ?? '')).not.toContain('available_skills')
  const firstUser = JSON.stringify(blocksOf(first).filter((b) => b.type === 'text'))
  expect(firstUser).toContain('<available_skills>')
  expect(firstUser).toContain('csv-stats')
  const loaded = JSON.stringify(
    blocksOf(generations[1]?.body as Record<string, unknown>).filter((b) => b.type === 'tool_result'),
  )
  expect(loaded).toContain(canary)
  expect(loaded).toContain('scripts/stats.js')
  const file = JSON.stringify(
    blocksOf(generations[2]?.body as Record<string, unknown>).filter((b) => b.type === 'tool_result'),
  )
  expect(file).toContain('values.reduce')

  await allowCall(run)
  await expect(content(await settled(page))).toHaveText('The mean is 4.')
  await expect(toolCard(page, sandbox.name_run_js)).toHaveAttribute('data-tool-status', 'done')
  // What the run printed reached the model on the next turn.
  const last = JSON.stringify(blocksOf(providers.lastBody('anthropic') as Record<string, unknown>))
  expect(last).toContain(canary)

  // Nothing of the skill or of the run is on the disk in plaintext.
  expect(plaintextHits(await dumpStorage(page), [canary, 'Summarize a list of numbers'])).toEqual([])
})
