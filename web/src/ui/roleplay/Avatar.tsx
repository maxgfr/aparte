import { useEffect, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import styles from './Roleplay.module.css'

/** A character's card image, decrypted into an object URL (revoked on lock); shown on the Characters screens only. */
export function Avatar({ blob, alt }: { blob: string | undefined; alt: string }) {
  const session = useSession()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (session === null || blob === undefined) return
    let live = true
    session.blobUrl(blob, 'image/png').then(
      (u) => live && setUrl(u),
      () => live && setUrl(null),
    )
    return () => {
      live = false
    }
  }, [session, blob])
  if (blob === undefined || url === null) return <span className={styles.avatar} aria-hidden="true" />
  return <img className={styles.avatar} src={url} alt={alt} width={44} height={44} loading="lazy" decoding="async" />
}

/** Saves `text` as a file the user downloads. */
export function downloadText(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
