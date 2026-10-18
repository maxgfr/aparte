import type { knowledge as source } from '../en/knowledge.ts'
import type { Shape } from '../index.ts'

/** German for the `knowledge` namespace; keys, kinds and placeholders match the English source. */
export const knowledge = {
  // Navigation and the list
  navKnowledge: 'Wissen',
  moreHint: 'Dokumente, auf die Ihre Chats zugreifen können, auf diesem Gerät gelesen und indexiert.',
  title: 'Wissen',
  lead: 'Dokumente, auf die Ihre Chats zugreifen können. Sie werden auf diesem Gerät gelesen und indexiert und wie Ihre Chats verschlüsselt gespeichert.',
  listTitle: 'Ihre Wissensdatenbanken',
  listEmpty: 'Noch keine Wissensdatenbank.',
  documents: 'Dokumente: {count}',
  newTitle: 'Neue Wissensdatenbank',
  newName: 'Name',
  newNamePlaceholder: 'Projektnotizen',
  create: 'Erstellen',
  trashedTitle: 'Gelöscht',
  restore: 'Wiederherstellen',
  restoreLabel: '{name} wiederherstellen',

  // One base
  missing: 'Diese Wissensdatenbank existiert nicht mehr.',
  missingBack: 'Alle Wissensdatenbanken',
  rename: 'Umbenennen',
  renameTitle: 'Wissensdatenbank umbenennen',
  save: 'Speichern',
  cancel: 'Abbrechen',
  delete: 'Löschen',
  deleteTitle: '{name} löschen?',
  deleteBody:
    'Chats, denen sie zugeordnet ist, finden ihre Dokumente nicht mehr. Ihre verschlüsselten Dateien bleiben in Ihrem Tresor, bis der Papierkorb geleert wird.',
  deleteConfirm: 'Löschen',
  deleted: '{name} gelöscht.',
  undo: 'Rückgängig',
  documentsTitle: 'Dokumente',
  documentsEmpty: 'Noch kein Dokument. Fügen Sie PDF-, Word-, PowerPoint-, HTML-, Markdown- oder Textdateien hinzu.',
  add: 'Dokumente hinzufügen',
  addHint:
    'PDF, DOCX, PPTX, HTML, Markdown und Klartext, jeweils bis 50 MB. Gescannte PDFs ohne Text können nicht gelesen werden.',
  documentMeta: '{size} · Passagen: {count}',
  remove: 'Entfernen',
  removeLabel: '{name} entfernen',
  removed: '{name} entfernt.',

  // Ingestion
  progressExtracting: '{name} wird gelesen…',
  progressEmbedding: '{name} wird indexiert: {done} von {total} Passagen…',
  progressSaving: '{name} wird gespeichert…',
  progressQueued: '{name} wartet…',
  progressLabel: 'Dokumente werden hinzugefügt',
  stop: 'Anhalten',
  added: '{name} hinzugefügt.',
  addedKeywords:
    '{name} hinzugefügt, nur über Stichwörter durchsuchbar: Das Einbettungsmodell konnte nicht ausgeführt werden.',
  failedUnsupported: '{name} ist kein Dateityp, den eine Wissensdatenbank lesen kann.',
  failedEmpty: '{name} enthält keinen Text zum Lesen (ein gescanntes PDF braucht zuerst eine Texterkennung).',
  failedEncrypted: '{name} ist passwortgeschützt.',
  failedTooLarge: '{name} ist zu groß.',
  failedCorrupt: '{name} konnte nicht gelesen werden: Die Datei ist möglicherweise beschädigt.',
  failedOther: '{name} konnte nicht hinzugefügt werden.',
  stopped: 'Das Hinzufügen von Dokumenten wurde gestoppt.',

  // Embeddings
  embedderTitle: 'Suche nach Bedeutung',
  embedderHint:
    'Passagen werden über ihre Wörter und über ihre Bedeutung gefunden. Für die Bedeutung braucht es ein Einbettungsmodell: auf diesem Gerät oder bei Ihrem Anbieter.',
  embedderLocal: 'Auf diesem Gerät ({model})',
  embedderLocalHint:
    'Einmal von Hugging Face geladen und anhand einer festgelegten Prüfsumme überprüft; danach bleibt alles hier. Am besten mit Englisch.',
  embedderProvider: '{provider}: {model}',
  embedderProviderHint: 'Passagen und Suchanfragen werden mit Ihrem Schlüssel zur Einbettung an {provider} gesendet.',
  embedderNone: 'Nur Stichwörter',
  embedderNoneHint:
    'Nichts wird irgendwohin gesendet; Passagen werden nur über die Wörter gefunden, die sie mit der Frage gemeinsam haben.',
  embedderLabel: 'Einbettungsmodell',
  reindexNeeded:
    'Einige Dokumente wurden mit einem anderen Modell oder ohne Modell indexiert: Sie werden nur über Stichwörter gefunden.',
  reindex: 'Neu indexieren',
  reindexDone: 'Dokumente neu indexiert: {count}.',
  reindexFailed: 'Das Einbettungsmodell konnte nicht ausgeführt werden. Prüfen Sie seinen Anbieter und Schlüssel.',

  // Attaching to a chat
  attach: 'Wissen',
  attachOn: 'Wissen: {count} aktiv',
  attachTitle: 'Wissen für diesen Chat',
  attachIntro:
    'Jede Nachricht, die Sie senden, erhält die relevantesten Passagen der gewählten Wissensdatenbanken, und das Modell kann sie durchsuchen. Ihr Text wird an den Anbieter dieses Chats gesendet.',
  attachEmpty: 'Noch keine Wissensdatenbank.',
  attachManage: 'Wissensdatenbanken verwalten',
  retrieving: 'Ihre Wissensdatenbanken werden durchsucht…',

  // In the thread
  contextChip: 'Passagen aus Ihrem Wissen: {count}',
  contextTitle: 'Mit dieser Nachricht gesendete Passagen',
  sourcesTitle: 'Quellen',
  sourceLabel: 'Quelle {n}: {document}',
  sourcePage: 'Seite {page}',
  passageTitle: 'Quelle {n}',
  passageFrom: 'Aus {document}',
  passageFromPage: 'Aus {document}, Seite {page}',
  close: 'Schließen',

  // The tool
  toolName: 'Ihr Wissen durchsuchen',
  toolHint:
    'Durchsucht die diesem Chat zugeordneten Wissensdatenbanken. Läuft ohne Nachfrage: Das Werkzeug liest nur, was Sie zugeordnet haben.',
} as const satisfies Shape<typeof source>
