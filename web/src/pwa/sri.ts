/**
 * Subresource Integrity metadata (`sha256-<base64>`), shared by the build (which stamps every precached file) and
 * the service worker (which checks every precached response before serving it). Pure Web Crypto: it runs the same
 * in Bun, in the page and in the worker.
 */

/** The algorithms SRI defines, strongest last: a metadata string is checked against its strongest digests only. */
const ALGORITHMS = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' } as const
type Algorithm = keyof typeof ALGORITHMS
const STRENGTH: readonly Algorithm[] = ['sha256', 'sha384', 'sha512']

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

/** The SRI metadata of `bytes`: `sha256-` followed by the base64 SHA-256 digest. */
export async function sriDigest(bytes: BufferSource, algorithm: Algorithm = 'sha256'): Promise<string> {
  const digest = await crypto.subtle.digest(ALGORITHMS[algorithm], bytes)
  return `${algorithm}-${toBase64(new Uint8Array(digest))}`
}

interface Expected {
  algorithm: Algorithm
  digest: string
}

/**
 * Parses SRI metadata into the expected digests of its strongest algorithm, as the SRI spec does: tokens with an
 * unknown algorithm are ignored and options (`?...`) are dropped. Empty when nothing usable is left, which callers
 * must treat as "cannot verify", never as "valid".
 */
export function parseIntegrity(metadata: string): Expected[] {
  const parsed: Expected[] = []
  for (const token of metadata.trim().split(/\s+/)) {
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(\?.*)?$/.exec(token)
    if (match?.[1] && match[2]) parsed.push({ algorithm: match[1] as Algorithm, digest: match[2] })
  }
  const strongest = Math.max(-1, ...parsed.map((p) => STRENGTH.indexOf(p.algorithm)))
  return parsed.filter((p) => STRENGTH.indexOf(p.algorithm) === strongest)
}

/** True when `bytes` match one of the strongest digests in `metadata`; false when it carries none usable. */
export async function matchesIntegrity(bytes: BufferSource, metadata: string): Promise<boolean> {
  const expected = parseIntegrity(metadata)
  const first = expected[0]
  if (!first) return false
  const actual = await sriDigest(bytes, first.algorithm)
  return expected.some((e) => `${e.algorithm}-${e.digest}` === actual)
}
