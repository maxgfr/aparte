/*
 * Ties a workspace to the vault that unlocked it. Invariants:
 * - While the workspace has captured updates that the pending queue has not acknowledged, it holds the vault's lock
 *   (`holdLock`), so locking waits for the write instead of losing it. A blocked queue releases the hold: a write that
 *   keeps failing must not keep the vault open.
 * - When the vault locks, the cleanups run first (they may still read the workspace), then the workspace closes and
 *   drops every decrypted document from memory.
 */

import type { Vault } from '../contracts/vault.ts'
import type { Workspace } from '../contracts/workspace.ts'

export type VaultLink = Pick<Vault, 'onLock' | 'holdLock'>

/** Returns the function that undoes the binding (without closing the workspace). */
export function bindWorkspaceToVault(
  vault: VaultLink,
  workspace: Workspace,
  cleanups: readonly (() => void)[] = [],
): () => void {
  let release: (() => void) | null = null
  let bound = true

  const sync = (): void => {
    if (!bound) return
    let status: ReturnType<Workspace['persistence']>
    try {
      status = workspace.persistence()
    } catch {
      return
    }
    const needed = status.unsaved > 0 && !status.blocked
    if (needed && release === null) {
      try {
        release = vault.holdLock('workspace-save')
      } catch {
        // The vault is already locking: nothing can be held any more, and the lock cleanup closes the workspace.
        release = null
      }
    } else if (!needed && release !== null) {
      const done = release
      release = null
      done()
    }
  }

  const offPersistence = workspace.onPersistence(sync)
  const offLock = vault.onLock(() => {
    for (const cleanup of cleanups) {
      try {
        cleanup()
      } catch {
        // One failing cleanup must not keep the documents in memory.
      }
    }
    unbind()
    workspace.close()
  })
  sync()

  function unbind(): void {
    if (!bound) return
    bound = false
    offLock()
    try {
      offPersistence()
    } catch {
      // Already closed.
    }
    const done = release
    release = null
    done?.()
  }
  return unbind
}
