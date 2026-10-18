import type { sync as source } from '../en/sync.ts'
import type { Shape } from '../index.ts'

/** French for the `sync` namespace; keys, kinds and placeholders match the English source. */
export const sync = {
  navSync: 'Synchro',
  title: 'Synchronisation',
  lead: 'Votre coffre se synchronise de bout en bout via un stockage qui vous appartient. Seuls les objets chiffrés et les emplacements de clé quittent cet appareil.',
  opening: 'Ouverture de la synchronisation…',
  noDestination:
    'Aucune destination pour l’instant : votre coffre reste sur cet appareil tant que vous n’en ajoutez pas une.',
  destinations: 'Destinations',
  syncNow: 'Synchroniser maintenant',
  remove: 'Retirer',
  removed: 'Destination retirée. Rien n’y a été supprimé.',

  // Status of a destination
  stateIdle: 'À jour',
  stateSyncing: 'Synchronisation en cours…',
  stateBackoff: 'Nouvelle tentative {time}',
  stateBackoffSoon: 'Nouvelle tentative bientôt',
  stateNeedsAuth: 'Les identifiants doivent être vérifiés',
  stateNeedsPermission: 'L’accès au dossier nécessite votre confirmation',
  stateError: 'Arrêtée',
  stateOffline: 'Hors ligne',
  lastSync: 'Dernière synchronisation {time}',
  neverSynced: 'Pas encore synchronisée',
  queued: 'En attente d’envoi : {count}',
  eta: 'Encore {duration} environ, au rythme de GitHub',
  lastError: 'Dernière erreur : {message}',
  grantAccess: 'Autoriser l’accès',

  // Warnings about a destination
  repoSize:
    'Ce dépôt contient {size}. GitHub recommande de rester sous 1 Go ; un bucket convient mieux à de nombreuses photos.',
  repoPublic:
    'Ce dépôt est public : n’importe qui peut voir combien d’objets chiffrés il contient et leur taille. Un dépôt privé est préférable.',
  tokenExpires: 'Le jeton expire le {date}. Créez-en un nouveau avant cette date et saisissez-le ici.',
  tokenExpired: 'Le jeton a expiré. Créez-en un nouveau et saisissez-le ici.',

  // Integrity alarms (spec/FORMAT.md section 10.3)
  alarmsTitle: 'Alertes d’intégrité',
  alarmsLead:
    'Rien sur cet appareil n’a été supprimé à cause de ces alertes. Elles signalent que le stockage a fait quelque chose d’anormal.',
  alarmRollback: 'Le stockage est revenu à un état antérieur : les segments qu’il listait auparavant ont disparu.',
  alarmWithheld: 'Le stockage laisse un trou dans l’historique : une partie en est retenue.',
  alarmUnreturned: 'Un autre appareil a vu des modifications que ce stockage ne restitue pas.',
  alarmFork:
    'Deux instances ont écrit sous la même identité d’appareil : un profil de navigateur copié, ou une attaque. Cet appareil a pris une nouvelle identité.',
  alarmTampered: 'Un objet ne passe pas l’authentification et a été refusé.',
  dismiss: 'Ignorer',

  // Adding destinations
  addTitle: 'Ajouter une destination',
  kindGithub: 'Dépôt GitHub',
  kindS3: 'Bucket compatible S3',
  kindFolder: 'Dossier de cet ordinateur',
  kindZip: 'Archive',
  tabGithub: 'GitHub',
  tabS3: 'S3',
  tabFolder: 'Dossier',
  githubHint:
    'Un dépôt privé et un jeton à granularité fine limité à ce dépôt, avec l’autorisation Contents en lecture et écriture.',
  s3Hint: 'AWS S3, Cloudflare R2, MinIO, Backblaze B2 ou Garage, avec une règle CORS pour cette application.',
  folderHint: 'Un dossier que vous choisissez. Placé dans un dossier synchronisé, il rejoint vos autres ordinateurs.',
  folderUnsupported: 'Ce navigateur ne peut pas écrire dans un dossier : utilisez un dépôt, un bucket ou une archive.',
  folderChoose: 'Choisir un dossier',
  folderAgain: 'Choisir de nouveau le dossier',
  folderAgainHint:
    'Les dossiers ne sont pas mémorisés après un rechargement : rien de lisible n’est conservé sur cet appareil.',
  credentialsHint:
    'Conservés chiffrés sur cet appareil uniquement. Jamais synchronisés : chaque appareil se configure séparément.',

  ghOwner: 'Propriétaire',
  ghRepo: 'Dépôt',
  ghBranch: 'Branche (facultatif)',
  ghToken: 'Jeton à granularité fine',
  ghTokenHint: 'Créez-le sur github.com, dans Settings, Developer settings, Fine-grained tokens : limité à ce dépôt.',
  connect: 'Vérifier et connecter',
  checking: 'Vérification…',
  connected: 'Connecté à {name}.',
  ghProblemToken: 'GitHub a refusé ce jeton.',
  ghProblemNotFound: 'Aucun compte GitHub ne porte ce nom.',
  ghProblemNoAccess: 'Dépôt introuvable, ou absent des dépôts auxquels ce jeton peut accéder.',
  ghProblemReadOnly: 'Ce jeton ne peut pas écrire dans le dépôt.',
  ghProblemRateLimited: 'GitHub demande d’attendre avant de réessayer.',
  ghProblemNetwork: 'Impossible de joindre GitHub.',

  s3Endpoint: 'Point d’accès',
  s3EndpointHint: 'Sans le bucket, par exemple https://<account>.r2.cloudflarestorage.com',
  s3Region: 'Région',
  s3Bucket: 'Bucket',
  s3Prefix: 'Dossier dans le bucket (facultatif)',
  s3AccessKey: 'Identifiant de clé d’accès',
  s3SecretKey: 'Clé d’accès secrète',
  s3Cors: 'Règle CORS du bucket',
  s3CorsLead: 'Le bucket doit autoriser l’adresse de cette application. Collez cette règle dans ses paramètres CORS :',
  s3Problem: 'Le bucket n’a pas pu être utilisé : {message}',
  invalidUrl: 'Saisissez une adresse https (http seulement pour cet ordinateur).',
  required: 'Obligatoire.',

  zipExport: 'Exporter une archive',
  zipImport: 'Importer une archive',
  zipHint:
    'Un fichier .aparte.zip contenant les objets chiffrés : une sauvegarde, ou un moyen d’emporter le coffre vers un autre appareil.',
  zipExported: 'Archive enregistrée. Objets : {count}.',
  zipImported: 'Archive importée.',
  zipFailed: 'L’archive n’a pas pu être lue : {message}',

  // Joining a vault from its store
  welcomeJoin: 'J’ai déjà un coffre',
  needsPassphraseTitle: 'La synchronisation exige une phrase de passe',
  needsPassphraseBody:
    'Un autre appareil ouvre ce coffre avec votre phrase de passe et la clé secrète de votre kit d’urgence. Ce coffre n’a encore ni l’une ni l’autre : il ne s’ouvre que sur cet appareil.',
  joinReplaces:
    'Le coffre que vous rejoignez remplace celui de cet appareil : les conversations qu’il contient maintenant sont supprimées.',
  joinTitle: 'Utiliser votre coffre sur cet appareil',
  joinLead:
    'Connectez-vous au stockage avec lequel votre autre appareil se synchronise. Ses emplacements de clé s’ouvrent avec votre phrase de passe et la clé secrète de votre kit d’urgence.',
  joinGithub: 'Depuis un dépôt GitHub',
  joinArchive: 'Depuis une archive',
  joinArchivePick: 'Choisir l’archive',
  joinFind: 'Rechercher le coffre',
  joinNone: 'Cette destination ne contient pas encore de coffre.',
  joinOther: 'Cette destination contient autre chose qu’un coffre Aparté, ou plusieurs coffres.',
  joinFailed: 'La destination n’a pas pu être lue : {message}',
  rememberSecretKey: 'Mémoriser la clé secrète sur cet appareil',
} as const satisfies Shape<typeof source>
