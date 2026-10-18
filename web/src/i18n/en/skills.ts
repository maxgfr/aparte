/** Skills: packaged instructions imported from GitHub, a zip or a folder, offered to models on demand. */
export const skills = {
  // Navigation
  navSkills: 'Skills',
  moreHint: 'Instructions and files that teach models a task',

  // The screen
  title: 'Skills',
  lead: 'A skill is a folder with a SKILL.md: instructions a model loads when a task matches, and the files they point to. Skills are stored encrypted in your vault and synced with it.',
  installed: 'Your skills',
  empty: 'No skill yet. Import one below.',
  trashedTitle: 'Removed',
  restore: 'Restore',
  restoreLabel: 'Restore {name}',

  // A skill
  enabled: 'Offer to models',
  enabledHint: 'Listed in chats that have the Skills tool; a model loads it when a task matches.',
  disabledHint: 'Installed, but no chat sees it.',
  userOnly: 'This skill asks to be invoked by you only, so it is never offered to a model.',
  remove: 'Remove',
  removeLabel: 'Remove {name}',
  removeConfirm: 'Remove {name}? It goes to the removed list, from where you can restore it.',
  details: 'Details',
  files: 'Files: {count}',
  version: 'Version {version}',
  license: 'License: {license}',
  allowedTools: 'Tools it asks for: {tools}. Shown for information: every tool still asks as usual.',
  warnings: 'Notes from the import',
  sourceGithub: 'GitHub · {repo} at {commit}',
  sourceZip: 'Zip · {name}',
  sourceFolder: 'Folder · {name}',
  scriptsNote:
    'Skill scripts never run in the app. A model can only run a JavaScript or Python script by passing its code to the sandbox tools, which show you the code and ask first.',
  fileList: 'Files of {name}',

  // Import
  importTitle: 'Import a skill',
  importHint:
    'The content of a skill comes from someone else: read what it says before you rely on it. It is shown to models as data, and nothing in it runs without your approval.',
  githubLabel: 'GitHub repository or folder',
  githubPlaceholder: 'owner/repo or https://github.com/owner/repo/tree/main/skills/name',
  githubHint: 'A public repository. Every folder with a SKILL.md under that path is imported.',
  githubImport: 'Import from GitHub',
  zipImport: 'Import a zip',
  folderImport: 'Import a folder',
  importing: 'Importing…',
  imported: 'Skills imported: {count}.',
  importedNames: 'Imported: {names}.',
  skippedFiles: 'Files left out: {count}.',

  // Import errors
  errorMalformed: 'That does not name a GitHub repository, or the archive is damaged.',
  errorNotFound: 'No SKILL.md was found there.',
  errorNetwork: 'GitHub could not be reached, or it refused the request. Check the address and your connection.',
  errorRateLimited: 'GitHub’s limit for requests without an account was reached. Try again in an hour.',
  errorTooLarge: 'The skill is too large to import.',
  errorInvalid: 'The SKILL.md could not be read: {message}',
  errorStorage: 'The skill could not be stored: {message}',

  // The tool
  toolName: 'Skills',
  toolHint:
    'Lets the model load the instructions of your enabled skills when a task matches. Runs without asking: it only reads them.',
} as const
