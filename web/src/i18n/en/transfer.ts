/** Import and export: conversations as Markdown, HTML or JSON, the encrypted backup, and other apps' exports. */
export const transfer = {
  title: 'Import and export',
  lead: 'Files you save here leave the vault: a backup stays encrypted, an exported conversation does not.',

  // Encrypted backup
  backupTitle: 'Encrypted backup',
  backupLead:
    'One .aparte file with the whole vault as it is stored: every conversation, photo and setting, encrypted. It opens only with your passphrase and Secret Key.',
  backupExport: 'Save a backup',
  backupExporting: 'Preparing the backup…',
  backupExported: 'Backup saved: {count} encrypted objects.',
  backupImportLabel: 'Merge a backup into this vault',
  backupImported: 'Backup merged. Anything it held that this vault lacked is back.',
  backupFailed: 'The backup did not go through: {message}',
  backupNewDevice: 'On a device without a vault, choose “I already have a vault” on the start screen, then this file.',

  // A backup opened with the app (file_handlers)
  launchTitle: 'A backup file was opened',
  launchBody: '“{name}” can be merged into this vault. Only objects of this same vault can be read from it.',
  launchImport: 'Merge it',
  launchDismiss: 'Not now',

  // Imports from other apps
  importTitle: 'Import from another app',
  importLead:
    'ChatGPT, Claude and Open WebUI exports (their conversations.json, or the export’s .zip as downloaded), and Aparté conversation files. Branches are kept.',
  importPick: 'Choose an export file',
  importReading: 'Reading the file…',
  importFound: 'Conversations found in this {source} export: {count}.',
  importButton: 'Import',
  importProgress: 'Importing {done} of {total}…',
  importDone: 'Conversations imported: {count}.',
  importSomeFailed: 'Conversations that could not be read and were skipped: {count}.',
  importUnknown: 'This file is not an export Aparté reads.',
  importNone: 'The file holds no conversation with messages.',
  importFailed: 'The import stopped: {message}',
  importModelNote: 'Imported answers keep their text; pick a model to continue a conversation.',
  openChats: 'Open chats',
  sourceChatgpt: 'ChatGPT',
  sourceClaude: 'Claude',
  sourceOpenwebui: 'Open WebUI',
  sourceAparte: 'Aparté',

  // Every conversation at once
  exportAllTitle: 'Export every conversation',
  exportAllLead: 'One JSON file with every conversation, its branches and its photos. It is not encrypted.',
  exportAllButton: 'Export as JSON',
  exportAllEmpty: 'There is no conversation to export yet.',

  // One conversation (from its actions)
  exportAction: 'Export',
  exportTitle: 'Export “{title}”',
  exportLead: 'The file is saved unencrypted: anyone who opens it can read the conversation.',
  exportMarkdown: 'Markdown',
  exportMarkdownHint: 'The branch on screen, as text.',
  exportHtml: 'Web page',
  exportHtmlHint: 'The branch on screen with its photos, in one file any browser opens.',
  exportJson: 'JSON',
  exportJsonHint: 'Every branch and photo; Aparté imports it again as it was.',
  exported: 'Saved {name}.',
  exportFailed: 'The export failed: {message}',

  // Words written into the exported files
  docYou: 'You',
  docSystem: 'System message',
  docReasoning: 'Reasoning',
  docImage: 'Photo',
  docTool: 'Tool',
  docSources: 'Sources',
  docModelUnknown: 'Model',
  docExported: 'Exported from Aparté on {date}',
} as const
