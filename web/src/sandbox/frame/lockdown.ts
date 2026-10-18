/*
 * What a sandbox worker removes from its own global scope before untrusted code runs. The frame's CSP already
 * refuses every connection, script load and storage of the opaque origin; this is a second wall, so a browser that
 * does not carry the policy into the worker still leaves the code without a way out: no network API, no storage, no
 * nested worker, no channel to other contexts.
 */

/** Global names a run never needs. */
export const REMOVED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'importScripts',
  'caches',
  'indexedDB',
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCRtpScriptTransform',
  'navigator',
  'FileSystemHandle',
  'FileSystemFileHandle',
  'FileSystemDirectoryHandle',
  'FileSystemSyncAccessHandle',
  'storage',
  'cookieStore',
] as const

/**
 * Deletes each name from `scope` and its prototype chain, then pins it to `undefined` so it cannot be put back.
 * `keep` names a replacement installed on the scope itself (the Python worker's in-memory `fetch`).
 */
export function lockDown(scope: object, keep: Readonly<Record<string, unknown>> = {}): void {
  for (const name of REMOVED) {
    for (let o: object | null = scope; o !== null; o = Object.getPrototypeOf(o)) {
      try {
        if (Object.hasOwn(o, name)) delete (o as Record<string, unknown>)[name]
      } catch {
        // A property the engine will not delete is pinned below.
      }
    }
    try {
      Object.defineProperty(scope, name, {
        value: Object.hasOwn(keep, name) ? keep[name] : undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      })
    } catch {
      // Already pinned.
    }
  }
}
