import type { knowledge as source } from '../en/knowledge.ts'
import type { Shape } from '../index.ts'

/** French for the `knowledge` namespace; keys, kinds and placeholders match the English source. */
export const knowledge = {
  // Navigation and the list
  navKnowledge: 'Connaissances',
  moreHint: 'Documents où vos conversations peuvent puiser, lus et indexés sur cet appareil.',
  title: 'Connaissances',
  lead: 'Documents où vos conversations peuvent puiser. Ils sont lus et indexés sur cet appareil, et stockés chiffrés, comme vos conversations.',
  listTitle: 'Vos bases de connaissances',
  listEmpty: 'Aucune base de connaissances pour le moment.',
  documents: 'Documents : {count}',
  newTitle: 'Nouvelle base de connaissances',
  newName: 'Nom',
  newNamePlaceholder: 'Notes de projet',
  create: 'Créer',
  trashedTitle: 'Supprimées',
  restore: 'Restaurer',
  restoreLabel: 'Restaurer {name}',

  // One base
  missing: 'Cette base de connaissances n’existe plus.',
  missingBack: 'Toutes les bases de connaissances',
  rename: 'Renommer',
  renameTitle: 'Renommer la base de connaissances',
  save: 'Enregistrer',
  cancel: 'Annuler',
  delete: 'Supprimer',
  deleteTitle: 'Supprimer {name} ?',
  deleteBody:
    'Les conversations auxquelles elle est rattachée ne trouvent plus ses documents. Ses fichiers chiffrés restent dans votre coffre jusqu’à ce qu’il soit vidé.',
  deleteConfirm: 'Supprimer',
  deleted: '{name} supprimée.',
  undo: 'Annuler',
  documentsTitle: 'Documents',
  documentsEmpty: 'Aucun document pour le moment. Ajoutez des fichiers PDF, Word, PowerPoint, HTML, Markdown ou texte.',
  add: 'Ajouter des documents',
  addHint:
    'PDF, DOCX, PPTX, HTML, Markdown et texte brut, jusqu’à 50 Mo chacun. Les PDF numérisés sans texte ne peuvent pas être lus.',
  documentMeta: '{size} · passages : {count}',
  remove: 'Retirer',
  removeLabel: 'Retirer {name}',
  removed: '{name} retiré.',

  // Ingestion
  progressExtracting: 'Lecture de {name}…',
  progressEmbedding: 'Indexation de {name} : {done} sur {total} passages…',
  progressSaving: 'Enregistrement de {name}…',
  progressQueued: '{name} est en attente…',
  progressLabel: 'Ajout de documents',
  stop: 'Arrêter',
  added: '{name} ajouté.',
  addedKeywords: '{name} ajouté, consultable par mots-clés uniquement : le modèle d’embeddings n’a pas pu s’exécuter.',
  failedUnsupported: '{name} n’est pas un type de fichier qu’une base de connaissances peut lire.',
  failedEmpty:
    '{name} ne contient aucun texte à lire (un PDF numérisé doit d’abord passer par la reconnaissance de texte).',
  failedEncrypted: '{name} est protégé par un mot de passe.',
  failedTooLarge: '{name} est trop volumineux.',
  failedCorrupt: '{name} n’a pas pu être lu : il est peut-être endommagé.',
  failedOther: '{name} n’a pas pu être ajouté.',
  stopped: 'L’ajout de documents a été arrêté.',

  // Embeddings
  embedderTitle: 'Recherche par le sens',
  embedderHint:
    'Les passages sont trouvés par leurs mots et par leur sens. Le sens nécessite un modèle d’embeddings : sur cet appareil, ou celui de votre fournisseur.',
  embedderLocal: 'Sur cet appareil ({model})',
  embedderLocalHint:
    'Téléchargé une seule fois depuis Hugging Face, vérifié par rapport à une empreinte fixée, puis tout reste ici. Plus efficace en anglais.',
  embedderProvider: '{provider} : {model}',
  embedderProviderHint:
    'Les passages et les recherches sont envoyés à {provider} pour être vectorisés, avec votre clé.',
  embedderNone: 'Mots-clés uniquement',
  embedderNoneHint:
    'Rien n’est envoyé nulle part : les passages sont trouvés uniquement par les mots qu’ils partagent avec la question.',
  embedderLabel: 'Modèle d’embeddings',
  reindexNeeded:
    'Certains documents ont été indexés avec un autre modèle ou sans modèle : ils ne sont trouvés que par mots-clés.',
  reindex: 'Réindexer',
  reindexDone: 'Documents réindexés : {count}.',
  reindexFailed: 'Le modèle d’embeddings n’a pas pu s’exécuter. Vérifiez son fournisseur et sa clé.',

  // Attaching to a chat
  attach: 'Connaissances',
  attachOn: 'Bases activées : {count}',
  attachTitle: 'Connaissances pour cette conversation',
  attachIntro:
    'Chaque message que vous envoyez reçoit les passages les plus pertinents des bases choisies, et le modèle peut les rechercher. Leur texte est envoyé au fournisseur de cette conversation.',
  attachEmpty: 'Aucune base de connaissances pour le moment.',
  attachManage: 'Gérer les bases de connaissances',
  retrieving: 'Recherche dans vos bases de connaissances…',

  // In the thread
  contextChip: 'Passages de vos connaissances : {count}',
  contextTitle: 'Passages envoyés avec ce message',
  sourcesTitle: 'Sources',
  sourceLabel: 'Source {n} : {document}',
  sourcePage: 'page {page}',
  passageTitle: 'Source {n}',
  passageFrom: 'Issu de {document}',
  passageFromPage: 'Issu de {document}, page {page}',
  close: 'Fermer',

  // The tool
  toolName: 'Rechercher dans vos connaissances',
  toolHint:
    'Recherche dans les bases de connaissances rattachées à cette conversation. S’exécute sans demander : l’outil ne lit que ce que vous avez rattaché.',
} as const satisfies Shape<typeof source>
