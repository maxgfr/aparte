/*
 * Copying a secret (a generated passphrase) to the system clipboard, and taking it back: the copy is overwritten
 * CLEAR_AFTER_MS later, or at once by `clearCopiedSecret` (which the vault runs on every lock), whichever comes first.
 *
 * The overwrite does not read the clipboard first (that needs a permission prompt in most browsers), so something the
 * user copied in the meantime is cleared too; the toast that confirms the copy says when it goes. A page without focus
 * may not write to the clipboard: the overwrite then waits for the page to get focus back.
 */

/** How long a copied secret stays on the clipboard. */
export const CLEAR_AFTER_MS = 30_000

let timer: ReturnType<typeof setTimeout> | null = null
let waiting = false

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

function overwrite(): void {
  stopTimer()
  navigator.clipboard.writeText('').then(
    () => {
      waiting = false
    },
    () => {
      // Not focused (or refused): try again when the page has focus.
      if (waiting) return
      waiting = true
      addEventListener(
        'focus',
        () => {
          waiting = false
          overwrite()
        },
        { once: true },
      )
    },
  )
}

/** Writes `text` to the clipboard and schedules its removal. */
export async function copySecret(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  stopTimer()
  timer = setTimeout(overwrite, CLEAR_AFTER_MS)
}

/** Overwrites a secret copied by `copySecret` that is still due to be cleared; does nothing otherwise. */
export function clearCopiedSecret(): void {
  if (timer !== null) overwrite()
}
