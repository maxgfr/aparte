import type { vault as source } from '../en/vault.ts'
import type { Shape } from '../index.ts'

/** German for the `vault` namespace; keys, kinds and placeholders match the English source. */
export const vault = {
  storageFailedTitle: 'Verschlüsselter Speicher ist nicht verfügbar',
  storageFailedBody:
    'Aparté konnte seinen Speicher in diesem Browser nicht öffnen, daher kann auf diesem Gerät nichts gespeichert werden. Ein privates Fenster kann ihn blockieren: Versuchen Sie ein normales Fenster und laden Sie dann neu.',

  createTitle: 'Tresor erstellen',
  createLead:
    'Alles, was Aparté speichert, wird auf diesem Gerät mit einem Schlüssel verschlüsselt, den nur Ihre Passphrase öffnet. Es gibt kein Konto und keinen Link zum Zurücksetzen.',
  choiceLabel: 'Passphrase',
  choiceGenerated: 'Eine erzeugen',
  choiceCustom: 'Eigene verwenden',
  generatedLabel: 'Ihre Passphrase',
  generatedHint:
    'Sechs zufällige Wörter, etwa 77 Bit. Schreiben Sie sie auf oder bewahren Sie sie in einem Passwort-Manager auf: Aparté speichert sie nie.',
  copy: 'Kopieren',
  copied: 'Passphrase kopiert. Sie wird in 30 Sekunden aus der Zwischenablage entfernt.',
  copyFailed: 'Dieser Browser hat das Kopieren verweigert: Markieren Sie die Wörter und kopieren Sie sie stattdessen.',
  regenerate: 'Neue Wörter',
  customLabel: 'Passphrase',
  customHint: 'Ein langer Satz, den nur Sie schreiben würden, eignet sich gut.',
  confirmLabel: 'Noch einmal eingeben',
  confirmMismatch: 'Die beiden Eingaben unterscheiden sich.',
  showPassphrase: 'Passphrase anzeigen',
  strength: 'Stärke',
  strengthChecking: 'Stärke wird geprüft…',
  strengthLoadFailed:
    'Die Stärkeprüfung konnte nicht geladen werden. Prüfen Sie die Verbindung und geben Sie dann erneut ein.',
  strength0: 'Sehr schwach: wird fast sofort erraten',
  strength1: 'Schwach: wird schnell erraten',
  strength2: 'Mittel, aber noch nicht genug',
  strength3: 'Stark',
  strength4: 'Sehr stark',
  strengthTooWeak: 'Zu leicht zu erraten: Fügen Sie Wörter hinzu oder machen Sie sie weniger vorhersehbar.',
  create: 'Tresor erstellen',
  creating: 'Ihr Tresor wird erstellt. Das dauert einige Sekunden…',
  createFailed: 'Der Tresor konnte nicht erstellt werden. Nichts wurde gespeichert: Versuchen Sie es erneut.',

  kitTitle: 'Ihr Notfallkit',
  kitLead:
    'Diese Schlüssel werden nur einmal angezeigt. Zusammen mit Ihrer Passphrase sind sie der einzige Weg zurück zu Ihren Daten auf einem neuen Gerät oder nach einer vergessenen Passphrase.',
  kitRecoveredLead:
    'Ihre neue Passphrase ist mit einem neuen geheimen Schlüssel gekoppelt. Bewahren Sie ihn auf: Jedes andere Gerät braucht ihn zusammen mit der neuen Passphrase.',
  kitRenewedLead:
    'Ihr Notfallkit wurde beim letzten Mal nicht bestätigt, daher hat es einen neuen Wiederherstellungsschlüssel: Der bisherige öffnet den Tresor nicht mehr. Diese Schlüssel werden nur einmal angezeigt.',
  kitPrintTitle: 'Aparté-Notfallkit',
  kitVault: 'Tresor',
  kitSecretKey: 'Geheimer Schlüssel',
  kitSecretKeyHint: 'Wird zusammen mit Ihrer Passphrase auf jedem neuen Gerät benötigt. Dieses Gerät merkt ihn sich.',
  kitRecoveryKey: 'Wiederherstellungsschlüssel',
  kitRecoveryKeyHint:
    'Öffnet den Tresor allein, falls Sie Ihre Passphrase vergessen. Bewahren Sie ihn getrennt von der Passphrase auf.',
  kitPassphraseLine: 'Passphrase (hier von Hand eintragen oder anderswo aufbewahren)',
  kitPrint: 'Drucken oder als PDF speichern',
  kitConfirm: 'Ich habe dieses Kit gedruckt oder aufgeschrieben und bewahre es sicher auf',
  kitContinue: 'Weiter',

  unlockLead: 'Gesperrt. Geben Sie Ihre Passphrase ein, um Ihren Tresor auf diesem Gerät zu öffnen.',
  passphraseLabel: 'Passphrase',
  secretKeyLabel: 'Geheimer Schlüssel',
  secretKeyHint: 'Aus Ihrem Notfallkit: Dieses Gerät merkt ihn sich nicht.',
  secretKeyLost:
    'Dieses Gerät kann seine Kopie Ihres geheimen Schlüssels nicht mehr lesen. Geben Sie ihn aus Ihrem Notfallkit ein oder verwenden Sie Ihren Wiederherstellungsschlüssel.',
  unlock: 'Entsperren',
  unlocking: 'Wird entsperrt…',
  emptyPassphrase: 'Geben Sie Ihre Passphrase ein.',
  wrongPassphrase: 'Diese Passphrase öffnet den Tresor nicht. Prüfen Sie sie und versuchen Sie es erneut.',
  wrongWithSecretKey:
    'Diese Passphrase und dieser geheime Schlüssel öffnen den Tresor nicht. Prüfen Sie beides und versuchen Sie es erneut.',
  badSecretKey: 'Das ist kein gültiger geheimer Schlüssel: Vergleichen Sie ihn mit Ihrem Notfallkit.',
  unlockFailed: 'Der Tresor konnte nicht geöffnet werden. Nichts wurde geändert: Versuchen Sie es erneut.',
  forgot: 'Wiederherstellungsschlüssel verwenden',
  lockedIdle: 'Nach einer Zeit ohne Aktivität gesperrt.',

  recoverTitle: 'Tresor wiederherstellen',
  recoverLead:
    'Ihr Wiederherstellungsschlüssel öffnet den Tresor und legt eine neue Passphrase fest. Die bisherige Passphrase öffnet den Tresor auf diesem Gerät nicht mehr.',
  recoveryKeyLabel: 'Wiederherstellungsschlüssel',
  recoveryKeyHint: '52 Buchstaben und Ziffern aus Ihrem Notfallkit; Leerzeichen und Bindestriche spielen keine Rolle.',
  newPassphraseLabel: 'Neue Passphrase',
  recover: 'Wiederherstellen und entsperren',
  recovering: 'Wird wiederhergestellt. Das dauert einige Sekunden…',
  emptyRecoveryKey: 'Geben Sie Ihren Wiederherstellungsschlüssel ein.',
  wrongRecoveryKey: 'Dieser Wiederherstellungsschlüssel öffnet den Tresor nicht.',
  badRecoveryKey:
    'Das ist kein Wiederherstellungsschlüssel: Er besteht aus 52 Buchstaben und Ziffern in Vierergruppen.',
  recoverFailed: 'Der Tresor konnte nicht wiederhergestellt werden. Nichts wurde geändert: Versuchen Sie es erneut.',
  backToUnlock: 'Zurück zum Entsperren',
  recovered: 'Entsperrt. Ihre neue Passphrase ist gesetzt.',

  homeUnlocked: 'Ihr Tresor ist auf diesem Gerät geöffnet. Er sperrt sich nach einigen Minuten ohne Aktivität selbst.',
  lock: 'Sperren',
  lockDeferred: 'Wird gesperrt, sobald die laufende Arbeit abgeschlossen ist…',
} as const satisfies Shape<typeof source>
