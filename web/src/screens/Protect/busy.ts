import { AparteError, type ErrorCode } from '../../core/contracts/crypto.ts'

/**
 * Resolves once the browser has painted the current frame. Argon2 runs on the main thread and holds it for a moment:
 * waiting for a paint first puts the busy state (spinner, status line) on screen before that pause. The timeout
 * covers a hidden page, where animation frames do not run.
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => resolve()
    requestAnimationFrame(() => setTimeout(done, 0))
    setTimeout(done, 100)
  })
}

/** The stable code of an error the vault threw on purpose; null for anything else. */
export function errorCode(e: unknown): ErrorCode | null {
  return e instanceof AparteError ? e.code : null
}
