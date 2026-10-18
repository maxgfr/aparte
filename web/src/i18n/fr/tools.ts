import type { tools as source } from '../en/tools.ts'
import type { Shape } from '../index.ts'

/** French for the `tools` namespace; keys, kinds and placeholders match the English source. */
export const tools = {
  // The tool set of a chat
  button: 'Outils',
  buttonOn: 'Outils activés : {count}',
  sheetTitle: 'Outils',
  sheetIntro:
    'Les outils permettent au modèle de chercher une information ou de calculer pendant qu’il répond. Un outil qui lit vos autres conversations ou accède à Internet vous demande l’autorisation avant chaque utilisation, sauf si vous l’autorisez une fois pour toutes.',
  frozenHint:
    'Les outils d’une conversation sont fixés par son premier message, afin que le modèle continue de lire la même discussion. Commencez une nouvelle conversation pour les modifier.',
  webSearch: 'Recherche web',
  webSearchHint:
    'Le fournisseur effectue lui-même la recherche sur le web et cite ses sources. Ses recherches peuvent être facturées.',
  webSearchUnavailable: 'Ce modèle n’a pas de recherche web propre.',
  noToolsModel: 'Ce modèle ne prend pas en charge les outils : ils restent désactivés pour lui.',
  modelTools: 'Autoriser ce modèle à utiliser des outils',
  modelToolsHint:
    'Le catalogue n’indique pas que ce modèle prend en charge les outils. Activez cette option s’il les prend en charge : la plupart des modèles hébergés et locaux récents le font.',
  drifted: '{name} a changé depuis le début de cette conversation : il n’est donc pas proposé ici.',
  missing: '{name} n’est plus disponible.',
  approvalsTitle: 'Toujours autorisés',
  approvalsEmpty: 'Aucun outil n’est toujours autorisé.',
  approvalsHint:
    'Les outils autorisés s’exécutent sans demander. Un outil dont la définition change demande de nouveau.',
  revoke: 'Révoquer',
  revokeLabel: 'Révoquer {name}',

  // Built-in tools
  name_current_time: 'Heure actuelle',
  name_calculator: 'Calculatrice',
  name_search_conversations: 'Rechercher dans vos conversations',
  name_fetch_url: 'Lire une page web',
  hint_current_time: 'La date et l’heure de cet appareil. S’exécute sans demander.',
  hint_calculator: 'Calcul exact. S’exécute sans demander.',
  hint_search_conversations:
    'Trouve des extraits de vos autres conversations. Demande d’abord : ils sont envoyés au fournisseur.',
  hint_fetch_url: 'Télécharge une page publique en HTTPS. Demande d’abord : l’outil accède à Internet.',

  // Tool calls and results
  callLabel: 'Appel d’outil : {name}',
  origin: 'depuis {origin}',
  statusApproval: 'En attente de votre autorisation',
  statusRunning: 'En cours…',
  statusDone: 'Terminé',
  statusFailed: 'Échec',
  statusDenied: 'Refusé',
  statusRefused: 'Non disponible dans cette conversation',
  statusSkipped: 'Non exécuté',
  statusPending: 'Pas encore de résultat',
  arguments: 'Arguments',
  argumentsAndResult: 'Arguments et résultat',
  result: 'Résultat',
  argumentsEmpty: 'Aucun argument.',
  readsOnly: 'Lecture seule',
  changesThings: 'Peut modifier des éléments',
  destructive: 'Peut supprimer ou écraser',
  openWorld: 'Accède à Internet',
  closedWorld: 'Reste sur cet appareil',
  notRunDenied: 'Vous l’avez refusé.',
  notRunStopped: 'La réponse a été arrêtée avant l’exécution de l’outil.',
  notRunBudget: 'La réponse a atteint sa limite d’étapes.',
  notRunUndeclared: 'Cette conversation ne dispose d’aucun outil de ce nom.',
  notRunDrifted: 'L’outil a changé depuis le début de cette conversation.',
  notRunMissing: 'L’outil n’est plus disponible.',
  notRunInterrupted: 'Aparté s’est fermé avant l’exécution de l’outil.',

  // Approval
  approveTitle: 'Autoriser {name} ?',
  approveBody:
    'Le modèle veut exécuter cet outil avec les arguments ci-dessous. Ils viennent du modèle et peuvent provenir d’un texte qu’il a lu : vérifiez-les avant de l’autoriser.',
  remember: 'Retenir mon choix',
  rememberOnce: 'Cette fois seulement',
  rememberConversation: 'Pour cette conversation',
  rememberAlways: 'Toujours, jusqu’à ce que cet outil change',
  approve: 'Autoriser',
  deny: 'Refuser',
  approvalPending: 'Un outil attend votre autorisation.',
  runningTools: 'Exécution des outils…',

  // Web search and sources
  searching: 'Recherche sur le web…',
  searched: 'Recherche sur le web : « {query} »',
  searchedNoQuery: 'Recherche sur le web',
  sources: 'Sources',
  sourceUntitled: 'Page sans titre',
} as const satisfies Shape<typeof source>
