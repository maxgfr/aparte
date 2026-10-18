import type { BrowserContext, Locator, Page } from '@playwright/test'
import { knowledge } from '../../src/i18n/en/knowledge.ts'
import { shell } from '../../src/i18n/en/shell.ts'
import { expect } from '../gates.ts'
import { ANSWER_WAIT } from './chat-ui.ts'

/*
 * Knowledge bases as the specs drive them, and the on-device embedding model played by the test. Browsers under test
 * do not download the pinned sentence-embedding model, so the request for the built transformers.js worker is answered
 * with a fake that speaks the same protocol (web/src/core/ai/local/embed.ts): it hashes the words of each text into
 * 64 buckets and returns unit-length vectors, deterministic, so a question shares a direction with the passages that
 * share its words. pdf.js, its worker and the knowledge worker are the real ones of the build.
 *
 *   [data-ingest]               the progress of the documents being added;
 *   [data-knowledge-context]    under a user message, the chip of the passages it was sent with;
 *   [data-knowledge-sources]    under an answer, the region of the sources it cites, one button per source
 *                               (with data-passage, the passage id).
 */

export const FAKE_EMBED_WORKER = `
const DIM = 64;
const embed = (t) => {
  const v = new Float32Array(DIM);
  for (const w of t.toLowerCase().match(/[a-z]+/g) || []) {
    let h = 7;
    for (const c of w.slice(0, 5)) h = (h * 31 + c.charCodeAt(0)) % DIM;
    v[h] += 1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
};
self.calls = 0;
self.addEventListener('message', (event) => {
  const req = event.data;
  if (!req || req.op !== 'embed') return;
  const vectors = req.texts.map(embed);
  self.postMessage({ id: req.id, kind: 'vectors', vectors }, vectors.map((v) => v.buffer));
});
`

/** Serves the fake embedding worker in place of the built one. */
export async function playEmbeddings(context: BrowserContext): Promise<void> {
  await context.route(/\/assets\/transformers\.worker-[\w-]+\.js$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_EMBED_WORKER }),
  )
}

/** Opens the Knowledge screen from the More hub of the navigation. */
export async function openKnowledge(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: shell.navMore, exact: true }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: shell.moreTitle, exact: true })).toBeVisible()
  await page
    .getByRole('link', { name: new RegExp(`^${knowledge.navKnowledge}`) })
    .first()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: knowledge.title, exact: true })).toBeVisible()
}

/** Creates a knowledge base named `name` and lands on its screen. */
export async function createBase(page: Page, name: string): Promise<void> {
  await openKnowledge(page)
  await page.getByLabel(knowledge.newName, { exact: true }).fill(name)
  await page.getByRole('button', { name: knowledge.create, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible()
}

export interface DocumentFile {
  readonly name: string
  readonly mimeType: string
  readonly buffer: Buffer
}

/** Adds `files` to the open knowledge base and waits until each one is listed and the queue is done. */
export async function addDocuments(page: Page, files: readonly DocumentFile[]): Promise<void> {
  await page.getByLabel(knowledge.add, { exact: true }).setInputFiles([...files])
  const list = page.getByRole('region', { name: knowledge.documentsTitle, exact: true })
  for (const f of files) await expect(list.getByText(f.name, { exact: true })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('[data-ingest]')).toHaveCount(0, { timeout: 60_000 })
}

/** The composer's Knowledge control. */
export const knowledgeButton = (page: Page) =>
  page.getByRole('button', { name: new RegExp(`^${knowledge.attach}(?::|$)`) })

/** Attaches the knowledge base `name` to the chat on screen. */
export async function attachBase(page: Page, name: string): Promise<void> {
  await knowledgeButton(page).click()
  const sheet = page.getByRole('dialog', { name: knowledge.attachTitle })
  await sheet.getByRole('switch', { name, exact: true }).check()
  await sheet.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(knowledgeButton(page)).toHaveAttribute('data-knowledge-count', '1')
}

/** The source buttons under `answer`. */
export const sourcesOf = (answer: Locator) => answer.locator('[data-knowledge-sources] [data-passage]')

export { ANSWER_WAIT }
