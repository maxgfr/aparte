import type { transfer as source } from '../en/transfer.ts'
import type { Shape } from '../index.ts'

/** German for the `transfer` namespace; keys, kinds and placeholders match the English source. */
export const transfer = {
  title: 'Import und Export',
  lead: 'Dateien, die Sie hier speichern, verlassen den Tresor: Ein Backup bleibt verschlüsselt, ein exportierter Chat nicht.',

  // Encrypted backup
  backupTitle: 'Verschlüsseltes Backup',
  backupLead:
    'Eine .aparte-Datei mit dem gesamten Tresor, so wie er gespeichert ist: jeder Chat, jedes Foto und jede Einstellung, verschlüsselt. Sie lässt sich nur mit Ihrer Passphrase und dem geheimen Schlüssel öffnen.',
  backupExport: 'Backup speichern',
  backupExporting: 'Backup wird vorbereitet…',
  backupExported: 'Backup gespeichert: {count} verschlüsselte Objekte.',
  backupImportLabel: 'Backup mit diesem Tresor zusammenführen',
  backupImported: 'Backup zusammengeführt. Was darin war und diesem Tresor fehlte, ist wieder da.',
  backupFailed: 'Das Backup ist nicht gelungen: {message}',
  backupNewDevice:
    'Wählen Sie auf einem anderen Gerät „Ich habe bereits einen Tresor“ auf dem Sync-Bildschirm und dann diese Datei.',
  backupNeedsPassphrase:
    'Ein Backup öffnet sich mit Ihrer Passphrase und dem geheimen Schlüssel aus Ihrem Notfallkit: Schützen Sie den Tresor zuerst mit einer Passphrase.',

  // A backup opened with the app (file_handlers)
  launchTitle: 'Eine Backup-Datei wurde geöffnet',
  launchBody:
    '„{name}“ kann mit diesem Tresor zusammengeführt werden. Daraus können nur Objekte desselben Tresors gelesen werden.',
  launchImport: 'Zusammenführen',
  launchDismiss: 'Nicht jetzt',

  // Imports from other apps
  importTitle: 'Import aus einer anderen App',
  importLead:
    'Exporte von ChatGPT, Claude und Open WebUI (deren conversations.json oder die heruntergeladene ZIP-Datei des Exports) sowie Aparté-Chatdateien. Zweige bleiben erhalten.',
  importPick: 'Exportdatei auswählen',
  importReading: 'Datei wird gelesen…',
  importFound: 'In diesem Export von {source} gefundene Chats: {count}.',
  importButton: 'Importieren',
  importProgress: '{done} von {total} werden importiert…',
  importDone: 'Importierte Chats: {count}.',
  importSomeFailed: 'Chats, die nicht gelesen werden konnten und übersprungen wurden: {count}.',
  importUnknown: 'Diese Datei ist kein Export, den Aparté lesen kann.',
  importNone: 'Die Datei enthält keinen Chat mit Nachrichten.',
  importFailed: 'Der Import wurde abgebrochen: {message}',
  importModelNote: 'Importierte Antworten behalten ihren Text; wählen Sie ein Modell, um einen Chat fortzusetzen.',
  openChats: 'Chats öffnen',
  sourceChatgpt: 'ChatGPT',
  sourceClaude: 'Claude',
  sourceOpenwebui: 'Open WebUI',
  sourceAparte: 'Aparté',

  // Every conversation at once
  exportAllTitle: 'Alle Chats exportieren',
  exportAllLead: 'Eine JSON-Datei mit allen Chats, ihren Zweigen und ihren Fotos. Sie ist nicht verschlüsselt.',
  exportAllButton: 'Als JSON exportieren',
  exportAllEmpty: 'Es gibt noch keinen Chat zum Exportieren.',

  // One conversation (from its actions)
  exportAction: 'Exportieren',
  exportTitle: '„{title}“ exportieren',
  exportLead: 'Die Datei wird unverschlüsselt gespeichert: Wer sie öffnet, kann den Chat lesen.',
  exportMarkdown: 'Markdown',
  exportMarkdownHint: 'Der Zweig auf dem Bildschirm, als Text.',
  exportHtml: 'Webseite',
  exportHtmlHint: 'Der Zweig auf dem Bildschirm mit seinen Fotos, in einer Datei, die jeder Browser öffnet.',
  exportJson: 'JSON',
  exportJsonHint: 'Jeder Zweig und jedes Foto; Aparté importiert alles wieder unverändert.',
  exported: '{name} gespeichert.',
  exportFailed: 'Der Export ist fehlgeschlagen: {message}',

  // Words written into the exported files
  docYou: 'Sie',
  docSystem: 'Systemnachricht',
  docReasoning: 'Denkprozess',
  docImage: 'Foto',
  docTool: 'Werkzeug',
  docSources: 'Quellen',
  docModelUnknown: 'Modell',
  docExported: 'Am {date} aus Aparté exportiert',
} as const satisfies Shape<typeof source>
