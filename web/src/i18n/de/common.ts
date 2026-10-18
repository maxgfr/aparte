import type { common as source } from '../en/common.ts'
import type { Shape } from '../index.ts'

/** German for the `common` namespace; keys, kinds and placeholders match the English source. */
export const common = {
  appName: 'Aparté',
  close: 'Schließen',
  back: 'Zurück',
  reload: 'Neu laden',
  later: 'Später',
  loading: 'Wird geladen…',
  yes: 'Ja',
  no: 'Nein',
  unknown: 'Unbekannt',
  opensInNewTab: '(öffnet sich in einem neuen Tab)',
  screenFailedTitle: 'Dieser Bildschirm konnte nicht geladen werden',
  screenFailedBody:
    'Aparté wurde vielleicht gerade aktualisiert, oder das Netzwerk ist beim Laden abgebrochen. Auf diesem Gerät wurde nichts verändert.',
} as const satisfies Shape<typeof source>
