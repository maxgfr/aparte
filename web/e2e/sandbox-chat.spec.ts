import { randomUUID } from 'node:crypto'
import { sandbox } from '../src/i18n/en/sandbox.ts'
import {
  allowCall,
  awaitingApproval,
  closeSheet,
  content,
  openTools,
  send,
  settled,
  startChat,
  toolCard,
  toolSwitch,
} from './fixtures/chat-ui.ts'
import { anthropicText, anthropicToolCalls } from './fixtures/sse.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { expect, test } from './fixtures/test.ts'

/*
 * run_js through the whole chat: the model calls it, the user approves it, it runs in the sandbox, and its output —
 * the file it wrote and the value it returned — is stored encrypted. The canary strings it produces must never be on
 * the device in plaintext, like any message content.
 */

test.use({ netPurposes: ['provider'] })

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5' } as const

test('a run_js call is approved, runs in the sandbox, and its output is stored encrypted', async ({
  page,
  providers,
}) => {
  test.setTimeout(180_000)
  const key = `sk-ant-api03-${randomUUID()}`
  await startChat(page, providers, { ...CLAUDE, key })

  // The sandbox tools are opt-in: turn run_js on before the first message.
  const sheet = await openTools(page)
  await toolSwitch(sheet, sandbox.name_run_js).check()
  await expect(toolSwitch(sheet, sandbox.name_run_python)).not.toBeChecked()
  await closeSheet(sheet)

  const fileCanary = `file-${randomUUID()}`
  const valueCanary = `value-${randomUUID()}`
  const code = `writeFile('note.txt', ${JSON.stringify(fileCanary)}); console.log('wrote it'); return ${JSON.stringify(valueCanary)}`
  providers.serve(
    'anthropic',
    anthropicToolCalls([{ id: 'toolu_js', name: 'run_js', input: { code } }], 'Running it.'),
    anthropicText(['Done.']),
  )
  await send(page, 'Write a note file and give me a token.')

  const card = await awaitingApproval(page, sandbox.name_run_js)
  await expect(card).toContainText('writeFile')
  await allowCall(card)

  await expect(content(await settled(page))).toHaveText('Done.')
  await expect(toolCard(page, sandbox.name_run_js)).toHaveAttribute('data-tool-status', 'done')
  // The output file is offered to the user, with a Download.
  await expect(toolCard(page, sandbox.name_run_js).getByText('note.txt', { exact: true })).toBeVisible()
  await expect(
    toolCard(page, sandbox.name_run_js).getByRole('button', {
      name: sandbox.downloadLabel.replace('{name}', 'note.txt'),
    }),
  ).toBeVisible()
  // The model was sent the run's output on the next turn.
  expect(JSON.stringify(providers.lastBody('anthropic'))).toContain(valueCanary)

  // Nothing of the run is on the disk in plaintext: not the written file, not the returned value, not the key.
  expect(plaintextHits(await dumpStorage(page), [key, fileCanary, valueCanary])).toEqual([])
})
