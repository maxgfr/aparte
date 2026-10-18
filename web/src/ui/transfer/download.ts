/*
 * Saving a file the app made (an export, a backup) through a temporary object URL, revoked right after: the bytes
 * never reach any storage of the app, only the user's downloads.
 */

/** Saves `content` as `name`. */
export function saveFile(content: Uint8Array | string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A file name from a title: letters, digits and dashes, at most 60 characters. */
export function fileStem(title: string, fallback: string): string {
  const stem = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
    .toLowerCase()
  return stem === '' ? fallback : stem
}

/** Today as `YYYY-MM-DD`, for file names. */
export function today(now = Date.now()): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
