/** The vault: its protection, the Emergency Kit, unlocking, recovery and locking. */
export const vault = {
  storageFailedTitle: 'Encrypted storage is unavailable',
  storageFailedBody:
    'Aparté could not open its storage in this browser, so nothing can be kept on this device. A private window may block it: try a regular one, then reload.',

  protectionTitle: 'Passphrase protection',
  protectionDevice: 'Not protected by a passphrase',
  protectionPassphrase: 'Protected by a passphrase',
  protectionDeviceBody:
    'Your chats are encrypted on this device under a key that the browser keeps and refuses to export, so a copy of the disk or a backup holds only ciphertext. But anyone who opens this browser opens Aparté, and another site served from the same origin could use that key to read your data.',
  protectionDeviceFix:
    'A passphrase closes both gaps: the vault then locks after a few minutes without activity and opens only with your passphrase. Sync and moving the vault to another device need it.',
  protectionPassphraseBody:
    'Only your passphrase opens the vault, with the Secret Key of your Emergency Kit on a new device. It locks itself after five minutes without activity.',
  protectAction: 'Protect with a passphrase',
  unprotectTitle: 'Remove passphrase protection',
  unprotectBody:
    'The vault then opens on this device without a prompt and stops locking itself: anyone who uses this browser, and another site of the same origin, could read it. Your passphrase, Secret Key and recovery key stop opening it here.',
  unprotectSyncFirst: 'This device syncs. Remove its sync destinations first: sync needs passphrase protection.',
  unprotect: 'Remove protection',
  unprotecting: 'Removing protection…',
  unprotectFailed: 'The protection could not be removed. Nothing was changed: try again.',
  unprotected: 'Passphrase protection removed. The vault opens on this device without a prompt.',

  protectTitle: 'Protect with a passphrase',
  protectLead:
    'With your passphrase and the Secret Key of the Emergency Kit that follows, the vault locks after a few minutes without activity and opens only for you, on this device and on your others. There is no account and no reset link.',
  choiceLabel: 'Passphrase',
  choiceGenerated: 'Generate one',
  choiceCustom: 'Use my own',
  generatedLabel: 'Your passphrase',
  generatedHint:
    'Six random words, about 77 bits. Write them down or keep them in a password manager: Aparté never stores them.',
  copy: 'Copy',
  copied: 'Passphrase copied. It is cleared from the clipboard in 30 seconds.',
  copyFailed: 'This browser refused the copy: select the words and copy them instead.',
  regenerate: 'New words',
  customLabel: 'Passphrase',
  customHint: 'A long sentence that only you would write works well.',
  confirmLabel: 'Type it again',
  confirmMismatch: 'The two entries differ.',
  showPassphrase: 'Show passphrase',
  strength: 'Strength',
  strengthChecking: 'Checking strength…',
  strengthLoadFailed: 'The strength check could not load. Check the connection, then type again.',
  strength0: 'Very weak: guessed almost at once',
  strength1: 'Weak: guessed quickly',
  strength2: 'Fair, not enough yet',
  strength3: 'Strong',
  strength4: 'Very strong',
  strengthTooWeak: 'Too easy to guess: add words or make it less predictable.',
  protect: 'Protect the vault',
  protecting: 'Protecting your vault. This takes a few seconds…',
  protectFailed: 'The passphrase could not be set. Nothing was changed: try again.',

  kitTitle: 'Your Emergency Kit',
  kitLead:
    'These keys are shown once. With your passphrase, they are the only way back into your data on a new device or after a forgotten passphrase.',
  kitRecoveredLead:
    'Your new passphrase is paired with a new Secret Key. Keep it: any other device needs it with the new passphrase.',
  kitRenewedLead:
    'Your Emergency Kit was not confirmed last time, so it has a new recovery key: the previous one no longer opens the vault. These keys are shown once.',
  kitPrintTitle: 'Aparté Emergency Kit',
  kitVault: 'Vault',
  kitSecretKey: 'Secret Key',
  kitSecretKeyHint: 'Needed with your passphrase on any new device. This device remembers it.',
  kitRecoveryKey: 'Recovery key',
  kitRecoveryKeyHint: 'Opens the vault on its own if you forget your passphrase. Keep it apart from the passphrase.',
  kitPassphraseLine: 'Passphrase (write it here by hand, or keep it elsewhere)',
  kitPrint: 'Print or save as PDF',
  kitConfirm: 'I printed or wrote down this kit and keep it somewhere safe',
  kitContinue: 'Continue',

  unlockLead: 'Locked. Enter your passphrase to open your vault on this device.',
  passphraseLabel: 'Passphrase',
  secretKeyLabel: 'Secret Key',
  secretKeyHint: 'From your Emergency Kit: this device does not remember it.',
  secretKeyLost:
    'This device can no longer read its copy of your Secret Key. Enter it from your Emergency Kit, or use your recovery key.',
  unlock: 'Unlock',
  unlocking: 'Unlocking…',
  emptyPassphrase: 'Enter your passphrase.',
  wrongPassphrase: 'This passphrase does not open the vault. Check it and try again.',
  wrongWithSecretKey: 'This passphrase and Secret Key do not open the vault. Check both and try again.',
  badSecretKey: 'This is not a valid Secret Key: compare it with your Emergency Kit.',
  unlockFailed: 'The vault could not be opened. Nothing was changed: try again.',
  forgot: 'Use my recovery key',
  lockedIdle: 'Locked after a period of inactivity.',

  recoverTitle: 'Recover your vault',
  recoverLead:
    'Your recovery key opens the vault and sets a new passphrase. The previous passphrase stops opening the vault on this device.',
  recoveryKeyLabel: 'Recovery key',
  recoveryKeyHint: '52 letters and digits from your Emergency Kit; spaces and hyphens do not matter.',
  newPassphraseLabel: 'New passphrase',
  recover: 'Recover and unlock',
  recovering: 'Recovering. This takes a few seconds…',
  emptyRecoveryKey: 'Enter your recovery key.',
  wrongRecoveryKey: 'This recovery key does not open the vault.',
  badRecoveryKey: 'This is not a recovery key: it has 52 letters and digits, in groups of four.',
  recoverFailed: 'The vault could not be recovered. Nothing was changed: try again.',
  backToUnlock: 'Back to unlock',
  recovered: 'Unlocked. Your new passphrase is set.',

  eraseLost: 'Lost your passphrase and recovery key?',
  eraseTitle: 'Erase all data on this device',
  eraseLostLead:
    'Without your passphrase or your recovery key, this vault can never be decrypted: not by you, not by Aparté, not by anyone.',
  eraseWhat:
    'Erasing removes everything Aparté keeps on this device: the vault, its conversations and keys, the share inbox and the preferences. The app then starts over, empty.',
  eraseSynced:
    'What this device already synced stays in your sync destination, as ciphertext nobody can read. Delete it there if you want it gone, for example by deleting the GitHub repository.',
  eraseModels: 'Also delete the downloaded on-device models and runtimes',
  eraseWord: 'erase',
  eraseConfirmLabel: 'Type “{word}” to confirm',
  eraseAction: 'Erase everything',
  erasing: 'Erasing this device…',
  eraseFailedTitle: 'The erase did not finish',
  eraseFailedBody: 'The browser refused to delete part of the data. Reload the app, then try again.',

  hintBody: 'Anyone who opens this browser can read these chats. Add a passphrase when you want them locked.',
  hintDismiss: 'Dismiss',

  deviceFailedLead:
    'This device can no longer open its vault: the key it kept for it is missing or damaged, for example after site data was partly cleared. No passphrase protects this vault, so there is no other way in on this device.',
  deviceFailedConfirm: 'I understand that what this device held is deleted',
  deviceFailedReset: 'Start over with an empty vault',
  deviceFailedResetFailed: 'The vault could not be replaced. Nothing was changed: reload and try again.',
  lock: 'Lock',
  lockDeferred: 'Locking once the current work finishes…',
} as const
