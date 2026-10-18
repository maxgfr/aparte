import { Download, Eye } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import type { ArtifactSource } from '../../core/contracts/sandbox.ts'
import type { Part } from '../../core/contracts/workspace.ts'
import { artifactOfFile } from '../../core/sandbox/artifacts.ts'
import { isRasterImage } from '../../core/sandbox/protocol.ts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../components/Button.tsx'
import styles from './Artifact.module.css'
import { ArtifactCard } from './Artifact.tsx'

/*
 * What a tool returned besides its text: figures and images shown inline, files offered for download, and HTML or SVG
 * files previewed as artifacts. Everything is read from the encrypted blob store into object URLs, which the session
 * revokes on lock; nothing a run wrote is ever inserted as markup of the app.
 */

type BlobPart = Extract<Part, { readonly type: 'image' | 'file' }>

function OutputImage({ part, alt }: { part: BlobPart; alt: string }) {
  const t = useT()
  const session = useSession()
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (session === null) return
    let live = true
    session.blobUrl(part.blob, part.mediaType).then(
      (u) => live && setUrl(u),
      () => live && setUrl(null),
    )
    return () => {
      live = false
    }
  }, [session, part.blob, part.mediaType])
  if (url === null) return <span className={styles.status}>{t('sandbox.fileMissing')}</span>
  return <img className={styles.image} src={url ?? undefined} alt={alt} loading="lazy" decoding="async" />
}

/** Saves a stored file to the device: its decrypted bytes through a short-lived object URL. */
async function save(blobs: { get(id: string): Promise<Uint8Array | null> }, part: BlobPart, name: string) {
  const bytes = await blobs.get(part.blob)
  if (bytes === null) return false
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

function OutputFile({ part }: { part: Extract<Part, { readonly type: 'file' }> }) {
  const t = useT()
  const session = useSession()
  const [missing, setMissing] = useState(false)
  const [artifact, setArtifact] = useState<ArtifactSource | null>(null)
  const previewable = part.mediaType === 'text/html' || part.mediaType === 'image/svg+xml'
  return (
    <li className={styles.file} data-output-file={part.name}>
      <span className={styles.fileName}>{part.name}</span>
      {previewable && artifact === null && (
        <Button
          variant="plain"
          icon={<Eye size={16} strokeWidth={2} aria-hidden="true" />}
          onClick={async () => {
            const bytes = session === null ? null : await session.blobs.get(part.blob)
            if (bytes === null) return setMissing(true)
            setArtifact(artifactOfFile(part.mediaType, new TextDecoder().decode(bytes)))
          }}
        >
          {t('sandbox.preview')}
        </Button>
      )}
      <Button
        variant="plain"
        aria-label={t('sandbox.downloadLabel', { name: part.name })}
        icon={<Download size={16} strokeWidth={2} aria-hidden="true" />}
        onClick={async () => {
          if (session === null || !(await save(session.blobs, part, part.name))) setMissing(true)
        }}
      >
        {t('sandbox.download')}
      </Button>
      {missing && <span className={styles.status}>{t('sandbox.fileMissing')}</span>}
      {artifact !== null && <ArtifactCard artifact={artifact} title={part.name} open />}
    </li>
  )
}

/** The images and files of a tool result, in order. */
export function ToolOutputs({ parts }: { parts: readonly Part[] }) {
  const t = useT()
  const images = parts.filter(
    (p): p is BlobPart => p.type === 'image' || (p.type === 'file' && isRasterImage(p.mediaType)),
  )
  const files = parts.filter(
    (p): p is Extract<Part, { type: 'file' }> => p.type === 'file' && !isRasterImage(p.mediaType),
  )
  if (images.length === 0 && files.length === 0) return null
  return (
    <div className={styles.outputs}>
      {images.length > 0 && (
        <div className={styles.images}>
          {images.map((part, i) => (
            <OutputImage
              key={part.blob}
              part={part}
              alt={part.type === 'file' ? part.name : t('sandbox.figure', { index: i + 1 })}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <>
          <p className={styles.label}>{t('sandbox.outputs')}</p>
          <ul className={styles.files}>
            {files.map((part) => (
              <OutputFile key={`${part.blob}:${part.name}`} part={part} />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
