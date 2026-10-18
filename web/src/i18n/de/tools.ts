import type { tools as source } from '../en/tools.ts'
import type { Shape } from '../index.ts'

/** German for the `tools` namespace; keys, kinds and placeholders match the English source. */
export const tools = {
  // The tool set of a chat
  button: 'Werkzeuge',
  buttonOn: 'Werkzeuge: {count} aktiv',
  sheetTitle: 'Werkzeuge',
  sheetIntro:
    'Werkzeuge erlauben dem Modell, beim Antworten etwas nachzuschlagen oder zu berechnen. Ein Werkzeug, das Ihre anderen Chats liest oder auf das Internet zugreift, fragt Sie vor jeder Verwendung, sofern Sie es nicht erlauben.',
  frozenHint:
    'Die Werkzeuge eines Chats werden durch seine erste Nachricht festgelegt, damit das Modell weiterhin denselben Chat liest. Starten Sie einen neuen Chat, um sie zu ändern.',
  webSearch: 'Websuche',
  webSearchHint:
    'Der Anbieter durchsucht das Web selbst und nennt seine Quellen. Die Suchen können kostenpflichtig sein.',
  webSearchUnavailable: 'Dieses Modell hat keine eigene Websuche.',
  noToolsModel: 'Dieses Modell unterstützt keine Werkzeuge, daher bleiben sie deaktiviert.',
  modelTools: 'Diesem Modell die Nutzung von Werkzeugen erlauben',
  modelToolsHint:
    'Der Katalog sagt nicht, dass dieses Modell Werkzeuge unterstützt. Aktivieren Sie die Option, wenn es das tut: Die meisten aktuellen gehosteten und lokalen Modelle tun es.',
  drifted: '{name} hat sich seit Beginn dieses Chats geändert, daher wird es hier nicht angeboten.',
  missing: '{name} ist nicht mehr verfügbar.',
  approvalsTitle: 'Immer erlaubt',
  approvalsEmpty: 'Kein Werkzeug ist immer erlaubt.',
  approvalsHint: 'Erlaubte Werkzeuge laufen ohne Nachfrage. Ein Werkzeug, dessen Definition sich ändert, fragt erneut.',
  revoke: 'Widerrufen',
  revokeLabel: '{name} widerrufen',

  // Built-in tools
  name_current_time: 'Aktuelle Uhrzeit',
  name_calculator: 'Rechner',
  name_search_conversations: 'Ihre Chats durchsuchen',
  name_fetch_url: 'Eine Webseite lesen',
  hint_current_time: 'Datum und Uhrzeit auf diesem Gerät. Läuft ohne Nachfrage.',
  hint_calculator: 'Exakte Arithmetik. Läuft ohne Nachfrage.',
  hint_search_conversations:
    'Findet Auszüge aus Ihren anderen Chats. Fragt vorher, denn die Auszüge werden an den Anbieter gesendet.',
  hint_fetch_url: 'Lädt eine öffentliche Seite über HTTPS herunter. Fragt vorher, denn es greift auf das Internet zu.',

  // Tool calls and results
  callLabel: 'Werkzeugaufruf: {name}',
  origin: 'von {origin}',
  statusApproval: 'Wartet auf Ihre Erlaubnis',
  statusRunning: 'Läuft…',
  statusDone: 'Fertig',
  statusFailed: 'Fehlgeschlagen',
  statusDenied: 'Abgelehnt',
  statusRefused: 'In diesem Chat nicht verfügbar',
  statusSkipped: 'Nicht ausgeführt',
  statusPending: 'Noch kein Ergebnis',
  arguments: 'Argumente',
  argumentsAndResult: 'Argumente und Ergebnis',
  result: 'Ergebnis',
  argumentsEmpty: 'Keine Argumente.',
  readsOnly: 'Liest nur',
  changesThings: 'Kann Dinge ändern',
  destructive: 'Kann löschen oder überschreiben',
  openWorld: 'Greift auf das Internet zu',
  closedWorld: 'Bleibt auf diesem Gerät',
  notRunDenied: 'Sie haben es abgelehnt.',
  notRunStopped: 'Die Antwort wurde gestoppt, bevor das Werkzeug lief.',
  notRunBudget: 'Die Antwort hat ihr Schrittlimit erreicht.',
  notRunUndeclared: 'Dieser Chat hat kein Werkzeug dieses Namens.',
  notRunDrifted: 'Das Werkzeug hat sich seit Beginn dieses Chats geändert.',
  notRunMissing: 'Das Werkzeug ist nicht mehr verfügbar.',
  notRunInterrupted: 'Aparté wurde geschlossen, bevor das Werkzeug lief.',

  // Approval
  approveTitle: '{name} erlauben?',
  approveBody:
    'Das Modell möchte dieses Werkzeug mit den unten stehenden Argumenten ausführen. Sie stammen vom Modell und können aus Text stammen, den es gelesen hat: Prüfen Sie sie, bevor Sie es erlauben.',
  remember: 'Meine Wahl merken',
  rememberOnce: 'Nur dieses Mal',
  rememberConversation: 'Für diesen Chat',
  rememberAlways: 'Immer, bis sich dieses Werkzeug ändert',
  approve: 'Erlauben',
  deny: 'Ablehnen',
  approvalPending: 'Ein Werkzeug wartet auf Ihre Erlaubnis.',
  runningTools: 'Werkzeuge laufen…',

  // Web search and sources
  searching: 'Websuche läuft…',
  searched: 'Im Web nach „{query}“ gesucht',
  searchedNoQuery: 'Im Web gesucht',
  sources: 'Quellen',
  sourceUntitled: 'Seite ohne Titel',
} as const satisfies Shape<typeof source>
