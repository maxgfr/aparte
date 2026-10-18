import type { mcp as source } from '../en/mcp.ts'
import type { Shape } from '../index.ts'

/** French for the `mcp` namespace; keys, kinds and placeholders match the English source. */
export const mcp = {
  // Where the servers are listed
  entry: 'Serveurs MCP',
  entryHint: 'Outils des serveurs que vous ajoutez, comme vos fichiers, vos tickets ou votre agenda.',
  title: 'Serveurs MCP',
  lead: 'Serveurs qui donnent plus d’outils au modèle. Le modèle vous demande votre autorisation avant d’en utiliser un.',
  yours: 'Vos serveurs',
  empty: 'Aucun serveur pour le moment.',
  add: 'Ajouter un serveur',
  addHint: 'Son adresse, et la manière de se connecter',
  corsTitle: 'Serveurs que le navigateur ne peut pas joindre',
  corsBody:
    'Aparté communique avec un serveur directement depuis cette page : le serveur doit donc autoriser les requêtes venant de {origin} (CORS). Pour un serveur qui ne le fait pas, ou qui tourne sur votre ordinateur sous forme de commande, utilisez la CLI Aparté : `aparte mcp bridge <nom>` le relaie depuis votre ordinateur à l’adresse http://127.0.0.1:27181/mcp/<nom>. Ajoutez cette adresse ici avec l’authentification par jeton et le jeton qu’affiche le relais.',

  // A server
  newTitle: 'Ajouter un serveur MCP',
  name: 'Nom',
  url: 'Adresse',
  urlHint: 'Le point d’accès MCP du serveur, par exemple https://example.com/mcp.',
  urlInvalid: 'Ce n’est pas une adresse.',
  urlInsecure: 'Utilisez https (http simple uniquement sur cet ordinateur).',
  urlQuery:
    'Retirez la chaîne de requête et le fragment : les jetons vont dans l’authentification ci-dessous, jamais dans l’adresse.',
  transport: 'Transport',
  transportHttp: 'Streamable HTTP',
  transportSse: 'SSE (serveurs plus anciens)',
  auth: 'Authentification',
  authNone: 'Aucune',
  authOauth: 'Se connecter',
  authBearer: 'Jeton',
  authHeaders: 'En-tête',
  authOauthHint:
    'Vous vous connectez sur la page du serveur lui-même, dans une fenêtre contextuelle. Les jetons qu’il délivre restent sur cet appareil, chiffrés, et ne sont envoyés qu’à ce serveur.',
  token: 'Jeton',
  tokenHint:
    'Envoyé à ce serveur uniquement, sous la forme « Authorization: Bearer ». Reste sur cet appareil, chiffré, jamais synchronisé.',
  headerName: 'Nom de l’en-tête',
  headerNamePlaceholder: 'X-Api-Key',
  headerValue: 'Valeur de l’en-tête',
  headerHint:
    'Envoyée avec chaque requête vers ce serveur uniquement. Reste sur cet appareil, chiffrée, jamais synchronisée.',
  secretInvalid: 'Retirez les espaces qui l’entourent, les sauts de ligne et les autres caractères de contrôle.',
  headerNameInvalid: 'Cet en-tête ne peut pas être envoyé : utilisez un nom tel que X-Api-Key.',
  create: 'Ajouter le serveur',
  notFound: 'Serveur introuvable',
  save: 'Enregistrer',
  settingsTitle: 'Adresse et authentification',
  saved: 'Enregistré.',
  enabled: 'Utiliser ce serveur',
  enabledHint: 'Désactivé : Aparté ne le contacte jamais et ses outils ne sont pas proposés.',
  credentials: 'Identifiants',
  credentialStored: 'Un identifiant est enregistré sur cet appareil.',
  credentialMissing: 'Aucun identifiant sur cet appareil pour le moment.',
  credentialSave: 'Enregistrer l’identifiant',
  credentialRemove: 'Supprimer l’identifiant',
  credentialSaved: 'Identifiant enregistré sur cet appareil.',
  credentialRemoved: 'Identifiant supprimé de cet appareil.',
  remove: 'Supprimer ce serveur',
  removed: 'Serveur supprimé.',

  // Connection
  test: 'Tester la connexion',
  status: 'État',
  statusOff: 'Désactivé.',
  statusConnecting: 'Connexion…',
  statusConnected: 'Connecté à {server}. Outils activés : {count}.',
  statusConnectedUnnamed: 'Connecté. Outils activés : {count}.',
  statusPreparing: 'Préparation de la connexion…',
  statusSignIn: 'Connectez-vous pour utiliser ce serveur.',
  statusWaiting: 'En attente de votre connexion dans la fenêtre contextuelle…',
  signIn: 'Se connecter',
  signInCancel: 'Annuler la connexion',
  signOut: 'Se déconnecter',
  signedOut: 'Déconnecté de ce serveur.',
  problemCors:
    'Le serveur répond, mais pas à Aparté : il n’autorise pas les requêtes venant de {origin} (CORS). Voyez ci-dessous ce que vous pouvez faire.',
  problemUnreachable: 'Le serveur est injoignable. Vérifiez l’adresse et que le serveur est bien lancé.',
  problemInsecure:
    'Cette adresse ne peut pas être utilisée : elle doit être en https (http simple uniquement sur cet ordinateur).',
  problemAuth: 'Le serveur a refusé les identifiants (HTTP {status}).',
  problemAuthMissing: 'Enregistrez d’abord un identifiant pour ce serveur.',
  problemSignIn: 'La connexion n’a pas abouti. Réessayez.',
  problemHttp: 'Le serveur a répondu par une erreur (HTTP {status}).',
  problemTimeout: 'Le serveur n’a pas répondu à temps.',
  problemProtocol: 'Le serveur n’a pas répondu comme un serveur MCP. Vérifiez l’adresse et le transport.',
  oauthSuggest: 'Ce serveur demande une connexion : choisissez « Se connecter » comme authentification.',

  // Tools
  tools: 'Outils',
  toolsHint:
    'Ce que chaque outil dit de lui-même vient du serveur. Chaque outil vous demande son autorisation avant de s’exécuter ; un outil dont la définition change reste désactivé jusqu’à ce que vous la réexaminiez.',
  toolsNone: 'Ce serveur ne propose aucun outil.',
  toolsUnknown: 'Connectez-vous pour voir ses outils.',
  calledAs: 'Appelé par le modèle sous le nom « {name} »',
  stateNew: 'Nouveau depuis l’ajout du serveur : désactivé jusqu’à ce que vous l’activiez.',
  stateChanged:
    'Sa définition a changé depuis que vous l’avez activé : il est donc suspendu. Relisez-la avant de l’accepter.',
  stateInvalid: 'Il ne peut pas être proposé : sa définition n’est pas valide.',
  accept: 'Accepter la nouvelle définition',
  acceptLabel: 'Accepter la nouvelle définition de {name}',
} as const satisfies Shape<typeof source>
