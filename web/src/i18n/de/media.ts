import type { media as source } from '../en/media.ts'
import type { Shape } from '../index.ts'

/** German for the `media` namespace; keys, kinds and placeholders match the English source. */
export const media = {
  // Dictation (the composer's microphone)
  dictate: 'Diktieren',
  dictateStop: 'Diktat beenden',
  dictateHold: 'Zum Diktieren gedrückt halten',
  dictateListening: 'Hört zu… Zum Beenden erneut drücken.',
  dictateListeningHold: 'Hört zu… Zum Beenden loslassen.',
  dictateTranscribing: 'Wird transkribiert…',
  dictateDownloading: 'Sprachmodell wird geladen: {percent} %',
  dictateDenied:
    'Der Zugriff auf das Mikrofon wurde verweigert. Erlauben Sie ihn in den Website-Einstellungen des Browsers, um zu diktieren.',
  dictateNoMicrophone: 'Auf diesem Gerät wurde kein Mikrofon gefunden.',
  dictateNothing: 'Es wurde nichts gehört.',
  dictateFailed: 'Das Diktat ist fehlgeschlagen.',
  dictateNoProvider: 'Zum Diktieren über einen Anbieter wählen Sie zuerst einen unter „Stimme und Medien“.',
  dictateUnsupported: 'Dieser Browser kann keine Audioaufnahmen machen.',

  // Reading aloud
  readAloud: 'Vorlesen',
  readStop: 'Vorlesen beenden',
  readNoVoice: 'Keine Stimme dieses Geräts unterstützt diese Sprache.',
  readFailed: 'Diese Antwort konnte nicht vorgelesen werden.',
  readNoProvider: 'Zum Vorlesen über einen Anbieter wählen Sie zuerst einen unter „Stimme und Medien“.',

  // Image turns
  imageMode: 'Bild erstellen',
  imageSend: 'Bild erstellen',
  imagePlaceholder: 'Beschreiben Sie das Bild, das erstellt werden soll',
  imageModel: 'Bildmodell',
  imageModelChip: 'Bildmodell: {model}',
  imageCreating: 'Bild wird erstellt…',
  imageAlt: 'Von {model} erstelltes Bild',
  imageFailed: 'Das Bild konnte nicht erstellt werden.',
  imageUnreadable: 'Der Anbieter hat ein Bild gesendet, das dieses Gerät nicht lesen kann.',

  // The Voice and media screen
  settingsTitle: 'Stimme und Medien',
  settingsLead:
    'Diktieren, Antworten vorlesen und Benachrichtigungen. Alles läuft auf diesem Gerät, sofern Sie keinen Anbieter wählen.',
  settingsLink: 'Stimme und Medien',
  settingsLinkHint: 'Diktieren, Vorlesen, Benachrichtigungen',
  dictationTitle: 'Diktieren',
  engineLocal: 'Auf diesem Gerät',
  engineApi: 'Anbieter',
  engineBrowser: 'Browserdienst',
  engineLocalHint:
    'Whisper läuft in diesem Browser. Das Modell (etwa 77 MB) wird beim ersten Gebrauch einmal geladen und anhand einer in dieser App festgelegten Prüfsumme überprüft. Ihre Stimme verlässt das Gerät nie.',
  engineApiHint: 'Ihre Aufnahme wird an den gewählten Anbieter gesendet, der den Text zurückgibt.',
  engineBrowserHint:
    'Der eigene Sprachdienst des Browsers sendet Ihre Stimme an die Server seines Herstellers (in Chrome: Google).',
  browserConfirmTitle: 'Ihre Stimme an die Server des Browsers senden?',
  browserConfirmBody:
    'Der in diesen Browser eingebaute Sprachdienst läuft nicht auf diesem Gerät: In Chrome wird jedes diktierte Wort an Google gesendet. Aparté kann nicht sehen oder begrenzen, was dort damit geschieht.',
  browserConfirm: 'Browserdienst verwenden',
  transcriptionProvider: 'Anbieter für Transkription',
  transcriptionModel: 'Modell für Transkription',
  speechProvider: 'Anbieter für Sprachausgabe',
  speechModel: 'Modell für Sprachausgabe',
  speechVoice: 'Stimme',
  speechVoiceHint:
    'OpenAI-Stimmen: alloy, ash, coral, echo, nova, sage, shimmer und weitere. Leer lassen, um die Standardstimme des Modells zu verwenden.',
  providerNone: 'Keiner Ihrer Anbieter bietet das an. OpenAI, Groq und OpenAI-kompatible Server bieten es an.',
  pushToTalk: 'Zum Sprechen gedrückt halten',
  pushToTalkHint: 'Halten Sie die Mikrofontaste gedrückt, während Sie sprechen, und lassen Sie sie los, um zu beenden.',
  readTitle: 'Vorlesen',
  readDevice: 'Stimmen dieses Geräts',
  readApi: 'Anbieter',
  readDeviceHint:
    'Es werden nur Stimmen verwendet, die auf diesem Gerät laufen: {count} sind hier verfügbar. Stimmen von Servern des Browsers werden nie verwendet.',
  readDeviceNone:
    'Dieses Gerät hat keine Stimme, die lokal läuft. Ohne einen Anbieter können Antworten nicht vorgelesen werden.',
  readApiHint: 'Der Text der Antwort wird an den gewählten Anbieter gesendet, der die Audiodatei zurückgibt.',
  notifyTitle: 'Benachrichtigungen',
  notifyAnswers: 'Benachrichtigen, wenn eine Antwort fertig ist',
  notifyAnswersHint:
    'Nur wenn Aparté im Hintergrund läuft. Die Benachrichtigung zeigt nie die Antwort oder den Titel des Chats.',
  notifyDenied:
    'Benachrichtigungen sind für diese Website blockiert: Erlauben Sie sie in den Website-Einstellungen des Browsers.',
  notifyUnsupported: 'Dieser Browser kann keine Benachrichtigungen von Aparté anzeigen.',
  notificationTitle: 'Aparté',
  notificationBody: 'Ihre Antwort ist fertig.',

  // The share inbox
  shareTitle: 'Mit Aparté geteilt',
  shareLead:
    'Was andere Apps mit Aparté teilen, wird beim Eintreffen auf diesem Gerät verschlüsselt, auch wenn der Tresor gesperrt ist, und wartet hier, bis Sie es verwenden.',
  shareEmpty: 'Es wartet nichts.',
  shareItem: 'Geteilt {time}',
  sharePhotos: 'Fotos: {count}',
  shareOtherFiles: 'Dateien, die keine Fotos sind, werden nicht übernommen: {count}',
  shareStart: 'Chat starten',
  shareDiscard: 'Verwerfen',
  shareDiscarded: 'Verworfen.',
  shareArrived: 'Mit Aparté wurde etwas geteilt.',
  shareReview: 'Ansehen',
  shareLost: 'Geteilte Elemente, die nicht geöffnet werden konnten, wurden entfernt: {count}',
  shareLoading: 'Geteilte Inhalte werden geöffnet…',
  shareFailed: 'Das Geteilte konnte nicht geöffnet werden.',
  receivedStored: 'Empfangen und auf diesem Gerät verschlüsselt.',
  receivedNoKey:
    'Zum Teilen muss der Tresor auf diesem Gerät schon einmal entsperrt worden sein. Entsperren Sie ihn und teilen Sie dann erneut.',
  receivedFull: 'Der Posteingang ist voll. Verwenden oder verwerfen Sie, was wartet, und teilen Sie dann erneut.',
  receivedTooLarge: 'Dieser Inhalt ist zu groß: höchstens 16 Dateien und 64 MB.',
  receivedEmpty: 'Es wurde nichts geteilt.',
  receivedInvalid: 'Das Geteilte konnte nicht gelesen werden.',
} as const satisfies Shape<typeof source>
