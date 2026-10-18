/** Knowledge bases: documents the model can read from, how they are added, and the sources an answer cites. */
export const knowledge = {
  // Navigation and the list
  navKnowledge: 'Knowledge',
  moreHint: 'Documents your chats can draw on, read and indexed on this device.',
  title: 'Knowledge',
  lead: 'Documents your chats can draw on. They are read and indexed on this device and stored encrypted, like your chats.',
  listTitle: 'Your knowledge bases',
  listEmpty: 'No knowledge base yet.',
  documents: 'Documents: {count}',
  newTitle: 'New knowledge base',
  newName: 'Name',
  newNamePlaceholder: 'Project notes',
  create: 'Create',
  trashedTitle: 'Deleted',
  restore: 'Restore',
  restoreLabel: 'Restore {name}',

  // One base
  missing: 'This knowledge base no longer exists.',
  missingBack: 'All knowledge bases',
  rename: 'Rename',
  renameTitle: 'Rename knowledge base',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  deleteTitle: 'Delete {name}?',
  deleteBody:
    'Chats it is attached to stop finding its documents. Its encrypted files stay in your vault until it is emptied.',
  deleteConfirm: 'Delete',
  deleted: '{name} deleted.',
  undo: 'Undo',
  documentsTitle: 'Documents',
  documentsEmpty: 'No document yet. Add PDF, Word, PowerPoint, HTML, Markdown or text files.',
  add: 'Add documents',
  addHint:
    'PDF, DOCX, PPTX, HTML, Markdown and plain text, up to 50 MB each. Scanned PDFs without text cannot be read.',
  documentMeta: '{size} · passages: {count}',
  remove: 'Remove',
  removeLabel: 'Remove {name}',
  removed: '{name} removed.',

  // Ingestion
  progressExtracting: 'Reading {name}…',
  progressEmbedding: 'Indexing {name}: {done} of {total} passages…',
  progressSaving: 'Saving {name}…',
  progressQueued: '{name} is waiting…',
  progressLabel: 'Adding documents',
  stop: 'Stop',
  added: '{name} added.',
  addedKeywords: '{name} added, searchable by keywords only: the embedding model did not run.',
  failedUnsupported: '{name} is not a kind of file a knowledge base reads.',
  failedEmpty: '{name} has no text to read (a scanned PDF needs text recognition first).',
  failedEncrypted: '{name} is password-protected.',
  failedTooLarge: '{name} is too large.',
  failedCorrupt: '{name} could not be read: it may be damaged.',
  failedOther: '{name} could not be added.',
  stopped: 'Adding documents was stopped.',

  // Embeddings
  embedderTitle: 'Search by meaning',
  embedderHint:
    'Passages are found by their words and by their meaning. Meaning needs an embedding model: on this device, or your provider’s.',
  embedderLocal: 'On this device ({model})',
  embedderLocalHint:
    'Downloaded once from Hugging Face, checked against a pinned digest, then everything stays here. Best with English.',
  embedderProvider: '{provider}: {model}',
  embedderProviderHint: 'Passages and searches are sent to {provider} to be embedded, with your key.',
  embedderNone: 'Keywords only',
  embedderNoneHint: 'Nothing is sent anywhere; passages are found only by the words they share with the question.',
  embedderLabel: 'Embedding model',
  reindexNeeded: 'Some documents were indexed with another model or without one: they are found by keywords only.',
  reindex: 'Index again',
  reindexDone: 'Documents indexed again: {count}.',
  reindexFailed: 'The embedding model could not run. Check its provider and key.',

  // Attaching to a chat
  attach: 'Knowledge',
  attachOn: 'Knowledge: {count} on',
  attachTitle: 'Knowledge for this chat',
  attachIntro:
    'Each message you send gets the most relevant passages of the bases you choose, and the model can search them. Their text goes to this chat’s provider.',
  attachEmpty: 'No knowledge base yet.',
  attachManage: 'Manage knowledge bases',
  retrieving: 'Looking in your knowledge bases…',

  // In the thread
  contextChip: 'Passages from your knowledge: {count}',
  contextTitle: 'Passages sent with this message',
  sourcesTitle: 'Sources',
  sourceLabel: 'Source {n}: {document}',
  sourcePage: 'page {page}',
  passageTitle: 'Source {n}',
  passageFrom: 'From {document}',
  passageFromPage: 'From {document}, page {page}',
  close: 'Close',

  // The tool
  toolName: 'Search your knowledge',
  toolHint: 'Searches the knowledge bases attached to this chat. Runs without asking: it reads only what you attached.',
} as const
