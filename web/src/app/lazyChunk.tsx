import { Component, type ComponentType, lazy, type ReactNode } from 'react'
import { useT } from '../i18n/react.tsx'
import { Button } from '../ui/components/Button.tsx'
import { EmptyState } from '../ui/components/EmptyState.tsx'
import { readSessionFlag, writeSessionFlag } from './prefs.ts'

/**
 * A lazily loaded screen. After a new version is deployed, a page opened before it asks for chunk files that no
 * longer exist: the first such failure reloads the page onto the new version, once per tab session, so a chunk that
 * is really gone (offline, never cached) ends on the boundary below instead of a reload loop.
 */
export function lazyChunk<T extends ComponentType<object>>(load: () => Promise<T>) {
  return lazy(async () => {
    try {
      const c = await load()
      writeSessionFlag('chunkReload', false)
      return { default: c }
    } catch (e) {
      // A storage that cannot be read counts as "already reloaded": never risk a reload loop.
      const reloaded = readSessionFlag('chunkReload') ?? true
      if (!reloaded && writeSessionFlag('chunkReload', true)) location.reload()
      throw e
    }
  })
}

function ScreenFailed() {
  const t = useT()
  return (
    <div role="alert">
      <EmptyState
        title={t('common.screenFailedTitle')}
        body={t('common.screenFailedBody')}
        action={
          <Button variant="primary" onClick={() => location.reload()}>
            {t('common.reload')}
          </Button>
        }
      />
    </div>
  )
}

/**
 * Shows a way out instead of a blank page when a screen fails to render. Keyed on the location by its parent, so
 * moving to another screen clears a failure.
 */
export class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? <ScreenFailed /> : this.props.children
  }
}
