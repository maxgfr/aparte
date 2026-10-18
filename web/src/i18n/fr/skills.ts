import type { skills as source } from '../en/skills.ts'
import type { Shape } from '../index.ts'

/** French for the `skills` namespace; keys, kinds and placeholders match the English source. */
export const skills = {
  // Navigation
  navSkills: 'Compétences',
  moreHint: 'Instructions et fichiers qui apprennent une tâche aux modèles',

  // The screen
  title: 'Compétences',
  lead: 'Une compétence est un dossier contenant un SKILL.md : des instructions qu’un modèle charge lorsqu’une tâche correspond, et les fichiers auxquels elles renvoient. Les compétences sont stockées chiffrées dans votre coffre et synchronisées avec lui.',
  installed: 'Vos compétences',
  empty: 'Aucune compétence pour l’instant. Importez-en une ci-dessous.',
  trashedTitle: 'Supprimées',
  restore: 'Restaurer',
  restoreLabel: 'Restaurer {name}',

  // A skill
  enabled: 'Proposer aux modèles',
  enabledHint:
    'Listée dans les conversations qui ont l’outil Compétences ; un modèle la charge lorsqu’une tâche correspond.',
  disabledHint: 'Installée, mais aucune conversation ne la voit.',
  userOnly: 'Cette compétence demande à n’être invoquée que par vous : elle n’est donc jamais proposée à un modèle.',
  remove: 'Supprimer',
  removeLabel: 'Supprimer {name}',
  removeConfirm:
    'Supprimer {name} ? Elle passe dans la liste des compétences supprimées, d’où vous pourrez la restaurer.',
  details: 'Détails',
  files: 'Fichiers : {count}',
  version: 'Version {version}',
  license: 'Licence : {license}',
  allowedTools:
    'Outils demandés : {tools}. À titre informatif : chaque outil demande toujours votre autorisation, comme d’habitude.',
  warnings: 'Remarques sur l’importation',
  sourceGithub: 'GitHub · {repo} à {commit}',
  sourceZip: 'Zip · {name}',
  sourceFolder: 'Dossier · {name}',
  scriptsNote:
    'Les scripts des compétences ne s’exécutent jamais dans l’application. Un modèle ne peut exécuter un script JavaScript ou Python qu’en transmettant son code aux outils du bac à sable, qui vous montrent le code et demandent d’abord votre accord.',
  fileList: 'Fichiers de {name}',

  // Import
  importTitle: 'Importer une compétence',
  importHint:
    'Le contenu d’une compétence vient d’un tiers : lisez ce qu’il dit avant de vous y fier. Il est présenté aux modèles comme des données, et rien de ce qu’il contient ne s’exécute sans votre accord.',
  githubLabel: 'Dépôt ou dossier GitHub',
  githubPlaceholder: 'owner/repo ou https://github.com/owner/repo/tree/main/skills/name',
  githubHint: 'Un dépôt public. Chaque dossier contenant un SKILL.md sous ce chemin est importé.',
  githubImport: 'Importer depuis GitHub',
  zipImport: 'Importer un zip',
  folderImport: 'Importer un dossier',
  importing: 'Importation…',
  imported: 'Compétences importées : {count}.',
  importedNames: 'Importées : {names}.',
  skippedFiles: 'Fichiers laissés de côté : {count}.',

  // Import errors
  errorMalformed: 'Cela ne désigne pas un dépôt GitHub, ou l’archive est endommagée.',
  errorNotFound: 'Aucun SKILL.md n’a été trouvé à cet emplacement.',
  errorNetwork: 'GitHub est injoignable, ou il a refusé la requête. Vérifiez l’adresse et votre connexion.',
  errorRateLimited: 'La limite de GitHub pour les requêtes sans compte a été atteinte. Réessayez dans une heure.',
  errorTooLarge: 'La compétence est trop volumineuse pour être importée.',
  errorInvalid: 'Le SKILL.md n’a pas pu être lu : {message}',
  errorStorage: 'La compétence n’a pas pu être enregistrée : {message}',

  // The tool
  toolName: 'Compétences',
  toolHint:
    'Permet au modèle de charger les instructions de vos compétences activées lorsqu’une tâche correspond. S’exécute sans demander : l’outil ne fait que les lire.',
} as const satisfies Shape<typeof source>
