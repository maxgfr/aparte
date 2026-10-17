/** The part of `navigator.serviceWorker` the probe uses. A blocked `register` may resolve with nothing. */
export interface WorkerContainer {
  register(url: string | TrustedScriptURL, options?: RegistrationOptions): Promise<unknown>
}

/**
 * Registers the worker script and says whether this page can run service workers at all, before workbox-window
 * (which assumes `register()` hands back a registration) takes over. Resolves false where they are absent or
 * blocked: no container, `register` resolving without a registration (Playwright's `serviceWorkers: 'block'`), or
 * refused with a `SecurityError` (service workers disabled, private modes). Also false on Firefox's `AbortError`,
 * raised when the page reloads while the worker is still installing (precaching over a slow network): the next
 * load registers again, so that case is dropped on purpose rather than surfaced as an uncaught page error.
 * Rejects on a real failure (the script missing or failing to evaluate, the network).
 */
export async function probeWorker(
  container: WorkerContainer | undefined,
  url: string | TrustedScriptURL,
  options: RegistrationOptions,
): Promise<boolean> {
  if (!container) return false
  try {
    return (await container.register(url, options)) != null
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'AbortError')) return false
    throw e
  }
}
