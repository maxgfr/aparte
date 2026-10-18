import type { mcp as source } from '../en/mcp.ts'
import type { Shape } from '../index.ts'

/** German for the `mcp` namespace; keys, kinds and placeholders match the English source. */
export const mcp = {
  // Where the servers are listed
  entry: 'MCP-Server',
  entryHint: 'Werkzeuge von Servern, die Sie hinzufügen, etwa für Ihre Dateien, Issues oder Ihren Kalender.',
  title: 'MCP-Server',
  lead: 'Server, die dem Modell weitere Werkzeuge geben. Das Modell fragt Sie, bevor es eines davon verwendet.',
  yours: 'Ihre Server',
  empty: 'Noch kein Server.',
  add: 'Server hinzufügen',
  addHint: 'Seine Adresse und wie Sie sich anmelden',
  corsTitle: 'Server, die der Browser nicht erreichen kann',
  corsBody:
    'Aparté verbindet sich direkt von dieser Seite aus mit einem Server. Deshalb muss der Server Anfragen von {origin} erlauben (CORS). Für einen Server, der das nicht tut, oder einen, der auf Ihrem Computer als Befehl läuft, nutzen Sie die Aparté-CLI: `aparte mcp bridge <name>` leitet ihn von Ihrem Computer unter http://127.0.0.1:27181/mcp/<name> weiter. Fügen Sie diese Adresse hier mit Token-Authentifizierung und dem Token hinzu, das die Bridge ausgibt.',

  // A server
  newTitle: 'MCP-Server hinzufügen',
  name: 'Name',
  url: 'Adresse',
  urlHint: 'Der MCP-Endpunkt des Servers, zum Beispiel https://example.com/mcp.',
  urlInvalid: 'Das ist keine Adresse.',
  urlInsecure: 'Verwenden Sie https (http nur auf diesem Computer).',
  urlQuery:
    'Entfernen Sie die Abfrage und das Fragment: Tokens gehören in die Authentifizierung unten, nie in die Adresse.',
  transport: 'Transport',
  transportHttp: 'Streamable HTTP',
  transportSse: 'SSE (ältere Server)',
  auth: 'Authentifizierung',
  authNone: 'Keine',
  authOauth: 'Anmelden',
  authBearer: 'Token',
  authHeaders: 'Header',
  authOauthHint:
    'Sie melden sich auf der eigenen Seite des Servers in einem Popup an. Die Tokens, die er ausgibt, bleiben verschlüsselt auf diesem Gerät und werden nur an diesen Server gesendet.',
  token: 'Token',
  tokenHint:
    'Wird nur an diesen Server als „Authorization: Bearer“ gesendet. Bleibt verschlüsselt auf diesem Gerät und wird nie synchronisiert.',
  headerName: 'Header-Name',
  headerNamePlaceholder: 'X-Api-Key',
  headerValue: 'Header-Wert',
  headerHint:
    'Wird mit jeder Anfrage nur an diesen Server gesendet. Bleibt verschlüsselt auf diesem Gerät und wird nie synchronisiert.',
  secretInvalid: 'Entfernen Sie Leerzeichen am Anfang und Ende, Zeilenumbrüche und andere Steuerzeichen.',
  headerNameInvalid: 'Dieser Header kann nicht gesendet werden: Verwenden Sie einen Namen wie X-Api-Key.',
  create: 'Server hinzufügen',
  notFound: 'Server nicht gefunden',
  save: 'Speichern',
  settingsTitle: 'Adresse und Authentifizierung',
  saved: 'Gespeichert.',
  enabled: 'Diesen Server verwenden',
  enabledHint: 'Aus: Aparté kontaktiert ihn nie, und seine Werkzeuge werden nicht angeboten.',
  credentials: 'Zugangsdaten',
  credentialStored: 'Auf diesem Gerät sind Zugangsdaten gespeichert.',
  credentialMissing: 'Auf diesem Gerät sind noch keine Zugangsdaten gespeichert.',
  credentialSave: 'Zugangsdaten speichern',
  credentialRemove: 'Zugangsdaten entfernen',
  credentialSaved: 'Zugangsdaten auf diesem Gerät gespeichert.',
  credentialRemoved: 'Zugangsdaten von diesem Gerät entfernt.',
  remove: 'Diesen Server entfernen',
  removed: 'Server entfernt.',

  // Connection
  test: 'Verbindung testen',
  status: 'Status',
  statusOff: 'Aus.',
  statusConnecting: 'Verbindung wird hergestellt…',
  statusConnected: 'Mit {server} verbunden. Aktive Werkzeuge: {count}.',
  statusConnectedUnnamed: 'Verbunden. Aktive Werkzeuge: {count}.',
  statusPreparing: 'Anmeldung wird vorbereitet…',
  statusSignIn: 'Melden Sie sich an, um diesen Server zu verwenden.',
  statusWaiting: 'Warten auf Ihre Anmeldung im Popup…',
  signIn: 'Anmelden',
  signInCancel: 'Anmeldung abbrechen',
  signOut: 'Abmelden',
  signedOut: 'Von diesem Server abgemeldet.',
  problemCors:
    'Der Server antwortet, aber nicht Aparté: Er erlaubt keine Anfragen von {origin} (CORS). Unten steht, was Sie tun können.',
  problemUnreachable: 'Der Server ist nicht erreichbar. Prüfen Sie die Adresse und ob der Server läuft.',
  problemInsecure:
    'Diese Adresse kann nicht verwendet werden, da sie https verwenden muss (http nur auf diesem Computer).',
  problemAuth: 'Der Server hat die Zugangsdaten abgelehnt (HTTP {status}).',
  problemAuthMissing: 'Speichern Sie zuerst Zugangsdaten für diesen Server.',
  problemSignIn: 'Die Anmeldung wurde nicht abgeschlossen. Versuchen Sie es erneut.',
  problemHttp: 'Der Server hat mit einem Fehler geantwortet (HTTP {status}).',
  problemTimeout: 'Der Server hat nicht rechtzeitig geantwortet.',
  problemProtocol: 'Der Server hat nicht als MCP-Server geantwortet. Prüfen Sie die Adresse und den Transport.',
  oauthSuggest: 'Dieser Server verlangt eine Anmeldung: Wählen Sie als Authentifizierung „Anmelden“.',

  // Tools
  tools: 'Werkzeuge',
  toolsHint:
    'Was jedes Werkzeug über sich selbst sagt, kommt vom Server. Jedes Werkzeug fragt Sie, bevor es läuft; ein Werkzeug, dessen Definition sich ändert, bleibt aus, bis Sie es erneut prüfen.',
  toolsNone: 'Dieser Server bietet kein Werkzeug an.',
  toolsUnknown: 'Verbinden Sie sich, um seine Werkzeuge zu sehen.',
  calledAs: 'Das Modell ruft es als {name} auf',
  stateNew: 'Neu seit dem Hinzufügen des Servers: aus, bis Sie es einschalten.',
  stateChanged:
    'Seine Definition hat sich seit dem Einschalten geändert, deshalb wird es zurückgehalten. Prüfen Sie die Definition erneut, bevor Sie sie akzeptieren.',
  stateInvalid: 'Es kann nicht angeboten werden: Seine Definition ist nicht gültig.',
  accept: 'Neue Definition akzeptieren',
  acceptLabel: 'Neue Definition von {name} akzeptieren',
} as const satisfies Shape<typeof source>
