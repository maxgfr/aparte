import type { transfer as source } from '../en/transfer.ts'
import type { Shape } from '../index.ts'

/** French for the `transfer` namespace; keys, kinds and placeholders match the English source. */
export const transfer = {
  title: 'Importer et exporter',
  lead: 'Les fichiers que vous enregistrez ici sortent du coffre : une sauvegarde reste chiffrée, une conversation exportée ne l’est pas.',

  // Encrypted backup
  backupTitle: 'Sauvegarde chiffrée',
  backupLead:
    'Un seul fichier .aparte contenant tout le coffre tel qu’il est stocké : conversations, photos et réglages, le tout chiffré. Il ne s’ouvre qu’avec votre phrase de passe et votre clé secrète.',
  backupExport: 'Enregistrer une sauvegarde',
  backupExporting: 'Préparation de la sauvegarde…',
  backupExported: 'Sauvegarde enregistrée. Objets chiffrés : {count}.',
  backupImportLabel: 'Fusionner une sauvegarde dans ce coffre',
  backupImported: 'Sauvegarde fusionnée. Tout ce qu’elle contenait et qui manquait à ce coffre a été rétabli.',
  backupFailed: 'La sauvegarde n’a pas abouti : {message}',
  backupNewDevice:
    'Sur un appareil sans coffre, choisissez « J’ai déjà un coffre » sur l’écran de démarrage, puis ce fichier.',

  // A backup opened with the app (file_handlers)
  launchTitle: 'Un fichier de sauvegarde a été ouvert',
  launchBody: '« {name} » peut être fusionné dans ce coffre. Seuls les objets de ce même coffre peuvent en être lus.',
  launchImport: 'Fusionner',
  launchDismiss: 'Pas maintenant',

  // Imports from other apps
  importTitle: 'Importer depuis une autre application',
  importLead:
    'Exports de ChatGPT, Claude et Open WebUI (leur fichier conversations.json, ou le .zip de l’export tel que téléchargé), et fichiers de conversation Aparté. Les branches sont conservées.',
  importPick: 'Choisir un fichier d’export',
  importReading: 'Lecture du fichier…',
  importFound: 'Conversations trouvées dans cet export {source} : {count}.',
  importButton: 'Importer',
  importProgress: 'Importation : {done} sur {total}…',
  importDone: 'Conversations importées : {count}.',
  importSomeFailed: 'Conversations illisibles, ignorées : {count}.',
  importUnknown: 'Ce fichier n’est pas un export qu’Aparté sait lire.',
  importNone: 'Le fichier ne contient aucune conversation avec des messages.',
  importFailed: 'L’importation s’est arrêtée : {message}',
  importModelNote: 'Les réponses importées gardent leur texte ; choisissez un modèle pour poursuivre une conversation.',
  openChats: 'Ouvrir les conversations',
  sourceChatgpt: 'ChatGPT',
  sourceClaude: 'Claude',
  sourceOpenwebui: 'Open WebUI',
  sourceAparte: 'Aparté',

  // Every conversation at once
  exportAllTitle: 'Exporter toutes les conversations',
  exportAllLead:
    'Un seul fichier JSON contenant chaque conversation, ses branches et ses photos. Il n’est pas chiffré.',
  exportAllButton: 'Exporter en JSON',
  exportAllEmpty: 'Il n’y a encore aucune conversation à exporter.',

  // One conversation (from its actions)
  exportAction: 'Exporter',
  exportTitle: 'Exporter « {title} »',
  exportLead: 'Le fichier est enregistré sans chiffrement : quiconque l’ouvre peut lire la conversation.',
  exportMarkdown: 'Markdown',
  exportMarkdownHint: 'La branche affichée, en texte.',
  exportHtml: 'Page web',
  exportHtmlHint: 'La branche affichée avec ses photos, dans un seul fichier que tout navigateur peut ouvrir.',
  exportJson: 'JSON',
  exportJsonHint: 'Toutes les branches et photos ; Aparté les réimporte à l’identique.',
  exported: 'Enregistré : {name}.',
  exportFailed: 'L’export a échoué : {message}',

  // Words written into the exported files
  docYou: 'Vous',
  docSystem: 'Message système',
  docReasoning: 'Raisonnement',
  docImage: 'Photo',
  docTool: 'Outil',
  docSources: 'Sources',
  docModelUnknown: 'Modèle',
  docExported: 'Exporté depuis Aparté le {date}',
} as const satisfies Shape<typeof source>
