import type { vault as source } from '../en/vault.ts'
import type { Shape } from '../index.ts'

/** German for the `vault` namespace; keys, kinds and placeholders match the English source. */
export const vault = {
  storageFailedTitle: 'Verschlüsselter Speicher ist nicht verfügbar',
  storageFailedBody:
    'Aparté konnte seinen Speicher in diesem Browser nicht öffnen, daher kann auf diesem Gerät nichts gespeichert werden. Ein privates Fenster kann ihn blockieren: Versuchen Sie ein normales Fenster und laden Sie dann neu.',

  protectionTitle: 'Schutz durch Passphrase',
  protectionDevice: 'Nicht durch eine Passphrase geschützt',
  protectionPassphrase: 'Durch eine Passphrase geschützt',
  protectionDeviceBody:
    'Ihre Chats sind auf diesem Gerät mit einem Schlüssel verschlüsselt, den der Browser aufbewahrt und nicht exportieren lässt: Eine Kopie der Festplatte oder ein Backup enthält also nur verschlüsselte Daten. Aber wer diesen Browser öffnet, öffnet Aparté, und eine andere Website desselben Ursprungs könnte diesen Schlüssel verwenden, um Ihre Daten zu lesen.',
  protectionDeviceFix:
    'Eine Passphrase schließt beide Lücken: Der Tresor sperrt sich dann nach einigen Minuten ohne Aktivität und öffnet sich nur mit Ihrer Passphrase. Die Synchronisierung und der Umzug des Tresors auf ein anderes Gerät setzen sie voraus.',
  protectionPassphraseBody:
    'Nur Ihre Passphrase öffnet den Tresor, auf einem neuen Gerät zusammen mit dem geheimen Schlüssel aus Ihrem Notfallkit. Er sperrt sich nach fünf Minuten ohne Aktivität selbst.',
  protectAction: 'Mit einer Passphrase schützen',
  unprotectTitle: 'Schutz durch Passphrase entfernen',
  unprotectBody:
    'Der Tresor öffnet sich dann auf diesem Gerät ohne Abfrage und sperrt sich nicht mehr: Wer diesen Browser benutzt, und eine andere Website desselben Ursprungs, könnte ihn lesen. Ihre Passphrase, Ihr geheimer Schlüssel und Ihr Wiederherstellungsschlüssel öffnen ihn hier nicht mehr.',
  unprotectSyncFirst:
    'Dieses Gerät synchronisiert. Entfernen Sie zuerst seine Sync-Ziele: Die Synchronisierung setzt den Schutz durch Passphrase voraus.',
  unprotect: 'Schutz entfernen',
  unprotecting: 'Schutz wird entfernt…',
  unprotectFailed: 'Der Schutz konnte nicht entfernt werden. Nichts wurde geändert: Versuchen Sie es erneut.',
  unprotected: 'Schutz durch Passphrase entfernt. Der Tresor öffnet sich auf diesem Gerät ohne Abfrage.',

  protectTitle: 'Mit einer Passphrase schützen',
  protectLead:
    'Mit Ihrer Passphrase und dem geheimen Schlüssel aus dem folgenden Notfallkit sperrt sich der Tresor nach einigen Minuten ohne Aktivität und öffnet sich nur für Sie, auf diesem Gerät wie auf Ihren anderen. Es gibt kein Konto und keinen Link zum Zurücksetzen.',
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
  protect: 'Tresor schützen',
  protecting: 'Ihr Tresor wird geschützt. Das dauert einige Sekunden…',
  protectFailed: 'Die Passphrase konnte nicht gesetzt werden. Nichts wurde geändert: Versuchen Sie es erneut.',

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

  eraseLost: 'Passphrase und Wiederherstellungsschlüssel verloren?',
  eraseTitle: 'Alle Daten auf diesem Gerät löschen',
  eraseLostLead:
    'Ohne Ihre Passphrase oder Ihren Wiederherstellungsschlüssel lässt sich dieser Tresor nie mehr entschlüsseln: nicht von Ihnen, nicht von Aparté, von niemandem.',
  eraseWhat:
    'Das Löschen entfernt alles, was Aparté auf diesem Gerät speichert: den Tresor, seine Chats und Schlüssel, den Eingang für Geteiltes und die Einstellungen. Die App beginnt danach leer von vorn.',
  eraseSynced:
    'Was dieses Gerät bereits synchronisiert hat, bleibt in Ihrem Sync-Ziel, verschlüsselt und für niemanden lesbar. Löschen Sie es dort, wenn es verschwinden soll, zum Beispiel indem Sie das GitHub-Repository löschen.',
  eraseModels: 'Auch die heruntergeladenen Modelle und Laufzeitumgebungen auf dem Gerät löschen',
  eraseWord: 'löschen',
  eraseConfirmLabel: 'Geben Sie „{word}“ zur Bestätigung ein',
  eraseAction: 'Alles löschen',
  erasing: 'Dieses Gerät wird gelöscht…',
  eraseFailedTitle: 'Das Löschen wurde nicht abgeschlossen',
  eraseFailedBody:
    'Der Browser hat sich geweigert, einen Teil der Daten zu löschen. Laden Sie die App neu und versuchen Sie es erneut.',

  homeUnlocked: 'Ihr Tresor ist auf diesem Gerät geöffnet. Er sperrt sich nach einigen Minuten ohne Aktivität selbst.',
  homeDevice:
    'Ihre Chats sind auf diesem Gerät verschlüsselt und öffnen sich ohne Abfrage. Noch schützt sie keine Passphrase.',
  hintBody:
    'Wer diesen Browser öffnet, kann diese Chats lesen. Fügen Sie eine Passphrase hinzu, wenn Sie sie sperren möchten.',
  hintDismiss: 'Ausblenden',

  deviceFailedLead:
    'Dieses Gerät kann seinen Tresor nicht mehr öffnen: Der dafür aufbewahrte Schlüssel fehlt oder ist beschädigt, zum Beispiel nachdem Websitedaten teilweise gelöscht wurden. Keine Passphrase schützt diesen Tresor, daher gibt es auf diesem Gerät keinen anderen Zugang.',
  deviceFailedConfirm: 'Mir ist klar, dass gelöscht wird, was dieses Gerät enthielt',
  deviceFailedReset: 'Mit einem leeren Tresor neu beginnen',
  deviceFailedResetFailed:
    'Der Tresor konnte nicht ersetzt werden. Nichts wurde geändert: Laden Sie neu und versuchen Sie es erneut.',
  lock: 'Sperren',
  lockDeferred: 'Wird gesperrt, sobald die laufende Arbeit abgeschlossen ist…',
} as const satisfies Shape<typeof source>
