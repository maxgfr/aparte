import type { sync as source } from '../en/sync.ts'
import type { Shape } from '../index.ts'

/** German for the `sync` namespace; keys, kinds and placeholders match the English source. */
export const sync = {
  navSync: 'Sync',
  title: 'Synchronisierung',
  lead: 'Ihr Tresor wird Ende-zu-Ende über einen Speicher synchronisiert, den Sie besitzen. Nur verschlüsselte Objekte und die Keyslots verlassen dieses Gerät.',
  opening: 'Synchronisierung wird geöffnet…',
  noDestination: 'Noch kein Ziel: Ihr Tresor bleibt auf diesem Gerät, bis Sie eines hinzufügen.',
  destinations: 'Ziele',
  syncNow: 'Jetzt synchronisieren',
  remove: 'Entfernen',
  removed: 'Ziel entfernt. Daraus wurde nichts gelöscht.',

  // Status of a destination
  stateIdle: 'Auf dem neuesten Stand',
  stateSyncing: 'Wird synchronisiert…',
  stateBackoff: 'Neuer Versuch {time}',
  stateBackoffSoon: 'Neuer Versuch gleich',
  stateNeedsAuth: 'Zugangsdaten prüfen',
  stateNeedsPermission: 'Der Zugriff auf den Ordner muss bestätigt werden',
  stateError: 'Angehalten',
  stateOffline: 'Offline',
  lastSync: 'Zuletzt synchronisiert {time}',
  neverSynced: 'Noch nicht synchronisiert',
  queued: 'Ausstehende Uploads: {count}',
  eta: 'Noch etwa {duration} im Tempo von GitHub',
  lastError: 'Letzter Fehler: {message}',
  grantAccess: 'Zugriff erlauben',

  // Warnings about a destination
  repoSize:
    'Dieses Repository enthält {size}. GitHub empfiehlt, unter 1 GB zu bleiben; für viele Fotos eignet sich ein Bucket besser.',
  repoPublic:
    'Dieses Repository ist öffentlich: Jeder kann sehen, wie viele verschlüsselte Objekte es enthält und wie groß sie sind. Ein privates ist besser.',
  tokenExpires: 'Das Token läuft am {date} ab. Erstellen Sie vorher ein neues und tragen Sie es hier ein.',
  tokenExpired: 'Das Token ist abgelaufen. Erstellen Sie ein neues und tragen Sie es hier ein.',

  // Integrity alarms (spec/FORMAT.md section 10.3)
  alarmsTitle: 'Integritätswarnungen',
  alarmsLead:
    'Auf diesem Gerät wurde deswegen nichts gelöscht. Die Warnungen zeigen, dass der Speicher etwas getan hat, was er nicht tun sollte.',
  alarmRollback:
    'Der Speicher ist in einen älteren Zustand zurückgefallen: Segmente, die er zuvor aufgelistet hat, fehlen.',
  alarmWithheld: 'Der Speicher hat eine Lücke in der Historie: Ein Teil wird zurückgehalten.',
  alarmUnreturned: 'Ein anderes Gerät hat Änderungen gesehen, die dieser Speicher nicht zurückgibt.',
  alarmFork:
    'Zwei Quellen haben unter derselben Geräteidentität geschrieben: ein kopiertes Browserprofil oder ein Angriff. Dieses Gerät hat eine neue Identität erhalten.',
  alarmTampered: 'Ein Objekt lässt sich nicht authentifizieren und wurde abgelehnt.',
  dismiss: 'Ausblenden',

  // Adding destinations
  addTitle: 'Ziel hinzufügen',
  kindGithub: 'GitHub-Repository',
  kindS3: 'S3-kompatibler Bucket',
  kindFolder: 'Ordner auf diesem Computer',
  kindZip: 'Archiv',
  tabGithub: 'GitHub',
  tabS3: 'S3',
  tabFolder: 'Ordner',
  githubHint:
    'Ein privates Repository und ein Fine-grained-Token nur für dieses Repository, mit der Berechtigung Contents: Lesen und Schreiben.',
  s3Hint: 'AWS S3, Cloudflare R2, MinIO, Backblaze B2 oder Garage, mit einer CORS-Regel für diese App.',
  folderHint: 'Ein Ordner Ihrer Wahl. In einem synchronisierten Laufwerk erreicht er Ihre anderen Computer.',
  folderUnsupported:
    'Dieser Browser kann nicht in einen Ordner schreiben; verwenden Sie ein Repository, einen Bucket oder ein Archiv.',
  folderChoose: 'Ordner wählen',
  folderAgain: 'Ordner erneut wählen',
  folderAgainHint:
    'Ordner werden nach einem Neuladen nicht gemerkt: Auf diesem Gerät bleibt nichts Lesbares gespeichert.',
  credentialsHint:
    'Nur verschlüsselt auf diesem Gerät gespeichert. Nie synchronisiert: Jedes Gerät wird separat eingerichtet.',

  ghOwner: 'Eigentümer',
  ghRepo: 'Repository',
  ghBranch: 'Zweig (optional)',
  ghToken: 'Fine-grained-Token',
  ghTokenHint:
    'Erstellen Sie es auf github.com unter Settings, Developer settings, Fine-grained tokens: nur für dieses Repository.',
  connect: 'Prüfen und verbinden',
  checking: 'Wird geprüft…',
  connected: 'Mit {name} verbunden.',
  ghProblemToken: 'GitHub hat dieses Token abgelehnt.',
  ghProblemNotFound: 'Es gibt kein GitHub-Konto mit diesem Namen.',
  ghProblemNoAccess: 'Repository nicht gefunden oder nicht unter den Repositories, die dieses Token verwenden darf.',
  ghProblemReadOnly: 'Dieses Token kann nicht in das Repository schreiben.',
  ghProblemRateLimited: 'GitHub bittet, vor einem neuen Versuch zu warten.',
  ghProblemNetwork: 'GitHub ist nicht erreichbar.',

  s3Endpoint: 'Endpunkt',
  s3EndpointHint: 'Ohne den Bucket, zum Beispiel https://<account>.r2.cloudflarestorage.com',
  s3Region: 'Region',
  s3Bucket: 'Bucket',
  s3Prefix: 'Ordner im Bucket (optional)',
  s3AccessKey: 'Access-Key-ID',
  s3SecretKey: 'Geheimer Zugriffsschlüssel',
  s3Cors: 'CORS-Regel für den Bucket',
  s3CorsLead:
    'Der Bucket muss die Adresse dieser App zulassen. Fügen Sie diese Regel in seinen CORS-Einstellungen ein:',
  s3Problem: 'Der Bucket konnte nicht verwendet werden: {message}',
  invalidUrl: 'Geben Sie eine https-Adresse ein (http nur für diesen Computer).',
  required: 'Pflichtfeld.',

  zipExport: 'Archiv exportieren',
  zipImport: 'Archiv importieren',
  zipHint:
    'Eine .aparte.zip-Datei mit den verschlüsselten Objekten: ein Backup oder ein Weg, den Tresor auf ein anderes Gerät zu bringen.',
  zipExported: 'Archiv gespeichert: {count} Objekte.',
  zipImported: 'Archiv importiert.',
  zipFailed: 'Das Archiv konnte nicht gelesen werden: {message}',

  // Joining a vault from its store
  welcomeJoin: 'Ich habe bereits einen Tresor',
  joinTitle: 'Ihren Tresor auf diesem Gerät verwenden',
  joinLead:
    'Verbinden Sie sich mit dem Speicher, mit dem Ihr anderes Gerät synchronisiert. Seine Keyslots öffnen sich mit Ihrer Passphrase und dem geheimen Schlüssel aus Ihrem Notfallkit.',
  joinGithub: 'Aus einem GitHub-Repository',
  joinArchive: 'Aus einem Archiv',
  joinArchivePick: 'Archiv wählen',
  joinFind: 'Tresor suchen',
  joinNone: 'Dieses Ziel enthält noch keinen Tresor.',
  joinOther: 'Dieses Ziel enthält etwas anderes als einen Aparté-Tresor oder mehrere Tresore.',
  joinFailed: 'Das Ziel konnte nicht gelesen werden: {message}',
  rememberSecretKey: 'Geheimen Schlüssel auf diesem Gerät merken',
} as const satisfies Shape<typeof source>
