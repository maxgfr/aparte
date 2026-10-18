import type { skills as source } from '../en/skills.ts'
import type { Shape } from '../index.ts'

/** German for the `skills` namespace; keys, kinds and placeholders match the English source. */
export const skills = {
  // Navigation
  navSkills: 'Skills',
  moreHint: 'Anleitungen und Dateien, die Modellen eine Aufgabe beibringen',

  // The screen
  title: 'Skills',
  lead: 'Ein Skill ist ein Ordner mit einer SKILL.md: Anleitungen, die ein Modell lädt, wenn eine Aufgabe passt, sowie die Dateien, auf die sie verweisen. Skills werden verschlüsselt in Ihrem Tresor gespeichert und mit ihm synchronisiert.',
  installed: 'Ihre Skills',
  empty: 'Noch kein Skill. Importieren Sie unten einen.',
  trashedTitle: 'Entfernt',
  restore: 'Wiederherstellen',
  restoreLabel: '{name} wiederherstellen',

  // A skill
  enabled: 'Modellen anbieten',
  enabledHint: 'Wird in Chats mit dem Werkzeug Skills aufgeführt; ein Modell lädt ihn, wenn eine Aufgabe passt.',
  disabledHint: 'Installiert, aber kein Chat sieht ihn.',
  userOnly: 'Dieser Skill soll nur von Ihnen aufgerufen werden, daher wird er nie einem Modell angeboten.',
  remove: 'Entfernen',
  removeLabel: '{name} entfernen',
  removeConfirm:
    '{name} entfernen? Er wandert in die Liste der entfernten Skills, von wo aus Sie ihn wiederherstellen können.',
  details: 'Details',
  files: 'Dateien: {count}',
  version: 'Version {version}',
  license: 'Lizenz: {license}',
  allowedTools: 'Angeforderte Werkzeuge: {tools}. Nur zur Information angezeigt: Jedes Werkzeug fragt wie gewohnt.',
  warnings: 'Hinweise aus dem Import',
  sourceGithub: 'GitHub · {repo}, Stand {commit}',
  sourceZip: 'ZIP · {name}',
  sourceFolder: 'Ordner · {name}',
  scriptsNote:
    'Skripte in Skills laufen nie in der App. Ein Modell kann ein JavaScript- oder Python-Skript nur ausführen, indem es dessen Code an die Sandbox-Werkzeuge übergibt, die Ihnen den Code zeigen und vorher fragen.',
  fileList: 'Dateien von {name}',

  // Import
  importTitle: 'Einen Skill importieren',
  importHint:
    'Der Inhalt eines Skills stammt von einer anderen Person: Lesen Sie, was darin steht, bevor Sie sich darauf verlassen. Modellen wird er als Daten gezeigt, und nichts darin läuft ohne Ihre Erlaubnis.',
  githubLabel: 'GitHub-Repository oder Ordner',
  githubPlaceholder: 'owner/repo oder https://github.com/owner/repo/tree/main/skills/name',
  githubHint: 'Ein öffentliches Repository. Jeder Ordner mit einer SKILL.md unter diesem Pfad wird importiert.',
  githubImport: 'Von GitHub importieren',
  zipImport: 'ZIP importieren',
  folderImport: 'Ordner importieren',
  importing: 'Wird importiert…',
  imported: 'Importierte Skills: {count}.',
  importedNames: 'Importiert: {names}.',
  skippedFiles: 'Ausgelassene Dateien: {count}.',

  // Import errors
  errorMalformed: 'Das ist kein Name eines GitHub-Repositorys, oder das Archiv ist beschädigt.',
  errorNotFound: 'Dort wurde keine SKILL.md gefunden.',
  errorNetwork:
    'GitHub ist nicht erreichbar oder hat die Anfrage abgelehnt. Prüfen Sie die Adresse und Ihre Verbindung.',
  errorRateLimited:
    'Das Limit von GitHub für Anfragen ohne Konto wurde erreicht. Versuchen Sie es in einer Stunde erneut.',
  errorTooLarge: 'Der Skill ist zu groß zum Importieren.',
  errorInvalid: 'Die SKILL.md konnte nicht gelesen werden: {message}',
  errorStorage: 'Der Skill konnte nicht gespeichert werden: {message}',

  // The tool
  toolName: 'Skills',
  toolHint:
    'Erlaubt dem Modell, die Anleitungen Ihrer aktivierten Skills zu laden, wenn eine Aufgabe passt. Läuft ohne Nachfrage: Das Werkzeug liest sie nur.',
} as const satisfies Shape<typeof source>
