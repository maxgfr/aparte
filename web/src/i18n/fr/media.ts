import type { media as source } from '../en/media.ts'
import type { Shape } from '../index.ts'

/** French for the `media` namespace; keys, kinds and placeholders match the English source. */
export const media = {
  // Dictation (the composer's microphone)
  dictate: 'Dicter',
  dictateStop: 'Arrêter la dictée',
  dictateHold: 'Maintenir pour dicter',
  dictateListening: 'Écoute en cours… appuyez à nouveau pour arrêter.',
  dictateListeningHold: 'Écoute en cours… relâchez pour arrêter.',
  dictateTranscribing: 'Transcription…',
  dictateDownloading: 'Téléchargement du modèle de reconnaissance vocale : {percent} %',
  dictateDenied:
    'L’accès au microphone a été refusé. Autorisez-le dans les paramètres du site, dans le navigateur, pour dicter.',
  dictateNoMicrophone: 'Aucun microphone n’a été trouvé sur cet appareil.',
  dictateNothing: 'Rien n’a été entendu.',
  dictateFailed: 'La dictée a échoué.',
  dictateNoProvider:
    'La dictée par un fournisseur nécessite d’en choisir un : sélectionnez-le dans « Voix et médias ».',
  dictateUnsupported: 'Ce navigateur ne peut pas enregistrer de son.',

  // Reading aloud
  readAloud: 'Lire à voix haute',
  readStop: 'Arrêter la lecture',
  readNoVoice: 'Aucune voix de cet appareil ne lit cette langue.',
  readFailed: 'Cette réponse n’a pas pu être lue à voix haute.',
  readNoProvider:
    'La lecture à voix haute par un fournisseur nécessite d’en choisir un : sélectionnez-le dans « Voix et médias ».',

  // Image turns
  imageMode: 'Créer une image',
  imageSend: 'Créer l’image',
  imagePlaceholder: 'Décrivez l’image à créer',
  imageModel: 'Modèle d’image',
  imageModelChip: 'Modèle d’image : {model}',
  imageCreating: 'Création de l’image…',
  imageAlt: 'Image créée par {model}',
  imageFailed: 'L’image n’a pas pu être créée.',
  imageUnreadable: 'Le fournisseur a envoyé une image que cet appareil ne peut pas lire.',

  // The Voice and media screen
  settingsTitle: 'Voix et médias',
  settingsLead:
    'Dictée, lecture des réponses à voix haute et notifications. Tout fonctionne sur cet appareil, sauf si vous choisissez un fournisseur.',
  settingsLink: 'Voix et médias',
  settingsLinkHint: 'Dictée, lecture à voix haute, notifications',
  dictationTitle: 'Dictée',
  engineLocal: 'Sur cet appareil',
  engineApi: 'Fournisseur',
  engineBrowser: 'Service du navigateur',
  engineLocalHint:
    'Whisper tourne dans ce navigateur. Son modèle (environ 77 Mo) se télécharge une seule fois, à la première utilisation, et il est vérifié par rapport à une empreinte fixée dans cette application. Votre voix ne quitte jamais l’appareil.',
  engineApiHint: 'Votre enregistrement est envoyé au fournisseur que vous choisissez, qui renvoie le texte.',
  engineBrowserHint:
    'Le service vocal du navigateur envoie votre voix aux serveurs de son éditeur (Google, dans Chrome).',
  browserConfirmTitle: 'Envoyer votre voix aux serveurs du navigateur ?',
  browserConfirmBody:
    'Le service vocal intégré à ce navigateur ne tourne pas sur cet appareil : dans Chrome, chaque mot dicté est envoyé à Google. Aparté ne peut ni voir ni limiter ce qui en est fait là-bas.',
  browserConfirm: 'Utiliser le service du navigateur',
  transcriptionProvider: 'Fournisseur de transcription',
  transcriptionModel: 'Modèle de transcription',
  speechProvider: 'Fournisseur de synthèse vocale',
  speechModel: 'Modèle de synthèse vocale',
  speechVoice: 'Voix',
  speechVoiceHint:
    'Voix OpenAI : alloy, ash, coral, echo, nova, sage, shimmer et d’autres. Vide : la voix par défaut du modèle.',
  providerNone:
    'Aucun de vos fournisseurs ne le propose. OpenAI, Groq et les serveurs compatibles OpenAI le proposent.',
  pushToTalk: 'Maintenir pour parler',
  pushToTalkHint: 'Maintenez le bouton du microphone enfoncé pendant que vous parlez, et relâchez-le pour arrêter.',
  readTitle: 'Lecture à voix haute',
  readDevice: 'Voix de cet appareil',
  readApi: 'Fournisseur',
  readDeviceHint:
    'Seules les voix qui tournent sur cet appareil sont utilisées (voix disponibles ici : {count}). Une voix des serveurs du navigateur n’est jamais utilisée.',
  readDeviceNone:
    'Cet appareil n’a aucune voix qui tourne en local : sans fournisseur, les réponses ne peuvent pas être lues à voix haute.',
  readApiHint: 'Le texte de la réponse est envoyé au fournisseur que vous choisissez, qui renvoie l’audio.',
  notifyTitle: 'Notifications',
  notifyAnswers: 'Me prévenir quand une réponse est prête',
  notifyAnswersHint:
    'Uniquement lorsqu’Aparté est en arrière-plan. La notification n’affiche jamais la réponse ni le titre de la conversation.',
  notifyDenied:
    'Les notifications sont bloquées pour ce site : autorisez-les dans les paramètres du site, dans le navigateur.',
  notifyUnsupported: 'Ce navigateur ne peut pas afficher de notifications d’Aparté.',
  notificationTitle: 'Aparté',
  notificationBody: 'Votre réponse est prête.',

  // The share inbox
  shareTitle: 'Partagé avec Aparté',
  shareLead:
    'Ce que d’autres applications partagent avec Aparté est chiffré sur cet appareil dès son arrivée, même lorsque le coffre est verrouillé, et attend ici jusqu’à ce que vous l’utilisiez.',
  shareEmpty: 'Rien n’attend.',
  shareItem: 'Partagé {time}',
  sharePhotos: 'Photos : {count}',
  shareOtherFiles: 'Fichiers écartés car ce ne sont pas des photos : {count}',
  shareStart: 'Démarrer une conversation',
  shareDiscard: 'Écarter',
  shareDiscarded: 'Écarté.',
  shareArrived: 'Quelque chose a été partagé avec Aparté.',
  shareReview: 'Examiner',
  shareLost: 'Les éléments partagés qui n’ont pas pu être ouverts ont été supprimés : {count}',
  shareLoading: 'Ouverture de ce qui a été partagé…',
  shareFailed: 'Ce qui a été partagé n’a pas pu être ouvert.',
  receivedStored: 'Reçu et chiffré sur cet appareil.',
  receivedNoKey:
    'Le partage nécessite que le coffre ait déjà été déverrouillé une fois sur cet appareil. Déverrouillez-le, puis partagez à nouveau.',
  receivedFull: 'La boîte de réception est pleine. Utilisez ou écartez ce qui attend, puis partagez à nouveau.',
  receivedTooLarge: 'Ce partage est trop volumineux : 16 fichiers et 64 Mo au maximum.',
  receivedEmpty: 'Rien n’a été partagé.',
  receivedInvalid: 'Le partage n’a pas pu être lu.',
} as const satisfies Shape<typeof source>
