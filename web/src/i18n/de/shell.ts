import type { shell as source } from '../en/shell.ts'
import type { Shape } from '../index.ts'

/** German for the `shell` namespace; keys, kinds and placeholders match the English source. */
export const shell = {
  skipToContent: 'Zum Inhalt springen',
  navMain: 'Hauptnavigation',
  navAbout: 'Info',
  navMore: 'Mehr',
  moreTitle: 'Mehr',
  moreCompare: 'Modelle vergleichen',
  moreArena: 'Arena',
  moreArenaHint: 'Zwei Modelle antworten blind; Ihre Stimmen bestimmen auf diesem Gerät ihre Rangfolge.',
  moreRoleplay: 'Rollenspiel',
  moreCharacters: 'Figuren und Lorebooks',
  moreCharactersHint: 'Figurenkarten, Lorebooks, Schnellantworten und Regex-Regeln.',
  moreData: 'Ihre Daten',
  moreTransfer: 'Import und Export',
  moreTransferHint: 'Markdown-, HTML- und JSON-Exporte, das verschlüsselte Backup, Importe aus anderen Apps.',
  moreStats: 'Nutzung',
  moreStatsHint: 'Token und Kosten pro Anbieter und Modell, auf diesem Gerät berechnet.',
  moreApp: 'Aparté',
  moreProtection: 'Schutz durch Passphrase',
  moreAbout: 'Über diese Version',
  updateReady: 'Eine neue Version von Aparté ist bereit.',
  updateApply: 'Aktualisieren',
  updateWaiting: 'Wird nach Abschluss der aktuellen Antwort aktualisiert…',
  offlineReady: 'Aparté funktioniert jetzt offline.',
  notFoundTitle: 'Hier gibt es nichts',
  notFoundBody: 'Diese Adresse passt zu keinem Bildschirm von Aparté.',
  notFoundHome: 'Zur Startseite',
} as const satisfies Shape<typeof source>
