/*
 * Shared setup of the workspace's own tests (not shipped: imported only by *.test.ts files). Real subkeys from the
 * spec vectors, the real LocalStore over fake-indexeddb, a manual clock and an in-process stand-in for
 * BroadcastChannel.
 */

import type { Subkeys } from '../contracts/crypto.ts'
import type { LocalDb, LocalStore } from '../contracts/store.ts'
import type { Clock } from '../contracts/vault.ts'
import type { Id, NewMessage, Workspace, WorkspaceDeps } from '../contracts/workspace.ts'
import { base32Encode, fromHex } from '../crypto/bytes.ts'
import { deriveSubkeys } from '../crypto/keys.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { createLocalStore, openLocalDb } from '../store/localStore.ts'
import { type ChannelLike, openWorkspace, type WorkspaceOptions } from './workspace.ts'

let cachedSubkeys: Promise<Subkeys> | null = null

export function testSubkeys(): Promise<Subkeys> {
  cachedSubkeys ??= (async () => {
    const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
      mk: string
      vaultId: string
    }
    return deriveSubkeys(fromHex(inputs.mk), fromHex(inputs.vaultId))
  })()
  return cachedSubkeys
}

export class FakeClock implements Clock {
  t = 1_760_000_000_000
  now(): number {
    return this.t
  }
  tick(ms = 1000): void {
    this.t += ms
  }
}

/** An in-process BroadcastChannel: what one member posts reaches every other member, asynchronously. */
export function channelHub(): { join(): ChannelLike; readonly posted: unknown[] } {
  const members = new Set<ChannelLike>()
  const posted: unknown[] = []
  return {
    posted,
    join() {
      const member: ChannelLike = {
        onmessage: null,
        postMessage(message) {
          posted.push(structuredClone(message))
          for (const other of members) {
            if (other === member) continue
            const data = structuredClone(message)
            setTimeout(() => other.onmessage?.({ data }), 0)
          }
        },
        close() {
          members.delete(member)
        },
      }
      members.add(member)
      return member
    },
  }
}

let count = 0
export const dbName = (): string => `workspace-own-${++count}-${crypto.randomUUID()}`

export interface Ctx {
  readonly name: string
  readonly db: LocalDb
  readonly store: LocalStore
  readonly clock: FakeClock
  readonly ws: Workspace
}

export async function openStore(name: string): Promise<{ db: LocalDb; store: LocalStore }> {
  const db = await openLocalDb({ name })
  return { db, store: createLocalStore({ db, subkeys: await testSubkeys(), rng: cryptoRng() }) }
}

export async function setup(options: WorkspaceOptions & { readonly name?: string } = {}): Promise<Ctx> {
  const name = options.name ?? dbName()
  const { db, store } = await openStore(name)
  const clock = new FakeClock()
  const ws = await openWorkspace({
    store,
    subkeys: await testSubkeys(),
    rng: cryptoRng(),
    clock,
    channel: null,
    ...options,
  })
  return { name, db, store, clock, ws }
}

export async function reopen(
  store: LocalStore,
  clock: Clock,
  options: WorkspaceOptions & Pick<WorkspaceDeps, 'retryDelayMs'> = {},
): Promise<Workspace> {
  return openWorkspace({ store, subkeys: await testSubkeys(), rng: cryptoRng(), clock, channel: null, ...options })
}

export const newId = (): Id => base32Encode(cryptoRng().bytes(16))

export function msg(
  id: Id,
  parent: Id | null,
  role: NewMessage['role'],
  text: string,
  extra: Partial<NewMessage> = {},
): NewMessage {
  return { id, parent, role, parts: [{ type: 'text', text }], model: null, status: 'done', ...extra }
}

/** Polls `check` until it holds (or fails after `ms`). */
export async function eventually(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > until) throw new Error('Condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
