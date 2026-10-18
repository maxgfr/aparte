import type { vault as source } from '../en/vault.ts'
import type { Shape } from '../index.ts'

/** French for the `vault` namespace; keys, kinds and placeholders match the English source. */
export const vault = {
  storageFailedTitle: 'Le stockage chiffré est indisponible',
  storageFailedBody:
    'Aparté n’a pas pu ouvrir son stockage dans ce navigateur, rien ne peut donc être conservé sur cet appareil. Une fenêtre de navigation privée peut le bloquer : essayez une fenêtre classique, puis rechargez la page.',

  createTitle: 'Créez votre coffre',
  createLead:
    'Tout ce qu’Aparté conserve est chiffré sur cet appareil, avec une clé que seule votre phrase de passe ouvre. Il n’y a ni compte ni lien de réinitialisation.',
  choiceLabel: 'Phrase de passe',
  choiceGenerated: 'En générer une',
  choiceCustom: 'Utiliser la mienne',
  generatedLabel: 'Votre phrase de passe',
  generatedHint:
    'Six mots aléatoires, soit environ 77 bits. Notez-les ou gardez-les dans un gestionnaire de mots de passe : Aparté ne les conserve jamais.',
  copy: 'Copier',
  copied: 'Phrase de passe copiée. Elle sera effacée du presse-papiers dans 30 secondes.',
  copyFailed: 'Ce navigateur a refusé la copie : sélectionnez les mots et copiez-les à la main.',
  regenerate: 'Nouveaux mots',
  customLabel: 'Phrase de passe',
  customHint: 'Une longue phrase que personne d’autre n’écrirait convient bien.',
  confirmLabel: 'Saisissez-la à nouveau',
  confirmMismatch: 'Les deux saisies ne correspondent pas.',
  showPassphrase: 'Afficher la phrase de passe',
  strength: 'Solidité',
  strengthChecking: 'Vérification de la solidité…',
  strengthLoadFailed:
    'La vérification de la solidité n’a pas pu se charger. Vérifiez la connexion, puis recommencez la saisie.',
  strength0: 'Très faible : devinée presque immédiatement',
  strength1: 'Faible : devinée rapidement',
  strength2: 'Correcte, mais pas encore suffisante',
  strength3: 'Solide',
  strength4: 'Très solide',
  strengthTooWeak: 'Trop facile à deviner : ajoutez des mots ou rendez-la moins prévisible.',
  create: 'Créer le coffre',
  creating: 'Création de votre coffre. Cela prend quelques secondes…',
  createFailed: 'Le coffre n’a pas pu être créé. Rien n’a été enregistré : réessayez.',

  kitTitle: 'Votre kit d’urgence',
  kitLead:
    'Ces clés ne sont affichées qu’une fois. Avec votre phrase de passe, elles sont le seul moyen de retrouver vos données sur un nouvel appareil ou après l’oubli de votre phrase de passe.',
  kitRecoveredLead:
    'Votre nouvelle phrase de passe est associée à une nouvelle clé secrète. Conservez-la : tout autre appareil en a besoin avec la nouvelle phrase de passe.',
  kitRenewedLead:
    'Votre kit d’urgence n’avait pas été confirmé la dernière fois : une nouvelle clé de récupération lui a donc été attribuée, et l’ancienne n’ouvre plus le coffre. Ces clés ne sont affichées qu’une fois.',
  kitPrintTitle: 'Kit d’urgence Aparté',
  kitVault: 'Coffre',
  kitSecretKey: 'Clé secrète',
  kitSecretKeyHint: 'Nécessaire avec votre phrase de passe sur tout nouvel appareil. Cet appareil la retient.',
  kitRecoveryKey: 'Clé de récupération',
  kitRecoveryKeyHint:
    'Ouvre à elle seule le coffre si vous oubliez votre phrase de passe. Rangez-la ailleurs que la phrase de passe.',
  kitPassphraseLine: 'Phrase de passe (à écrire ici à la main, ou à conserver ailleurs)',
  kitPrint: 'Imprimer ou enregistrer en PDF',
  kitConfirm: 'J’ai imprimé ou noté ce kit et je le garde en lieu sûr',
  kitContinue: 'Continuer',

  unlockLead: 'Verrouillé. Saisissez votre phrase de passe pour ouvrir votre coffre sur cet appareil.',
  passphraseLabel: 'Phrase de passe',
  secretKeyLabel: 'Clé secrète',
  secretKeyHint: 'Elle figure dans votre kit d’urgence : cet appareil ne la retient pas.',
  secretKeyLost:
    'Cet appareil ne peut plus lire sa copie de votre clé secrète. Saisissez-la depuis votre kit d’urgence, ou utilisez votre clé de récupération.',
  unlock: 'Déverrouiller',
  unlocking: 'Déverrouillage…',
  emptyPassphrase: 'Saisissez votre phrase de passe.',
  wrongPassphrase: 'Cette phrase de passe n’ouvre pas le coffre. Vérifiez-la et réessayez.',
  wrongWithSecretKey:
    'Cette phrase de passe et cette clé secrète n’ouvrent pas le coffre. Vérifiez les deux et réessayez.',
  badSecretKey: 'Ce n’est pas une clé secrète valide : comparez-la avec votre kit d’urgence.',
  unlockFailed: 'Le coffre n’a pas pu être ouvert. Rien n’a été modifié : réessayez.',
  forgot: 'Utiliser ma clé de récupération',
  lockedIdle: 'Verrouillé après une période d’inactivité.',

  recoverTitle: 'Récupérer votre coffre',
  recoverLead:
    'Votre clé de récupération ouvre le coffre et définit une nouvelle phrase de passe. L’ancienne phrase de passe n’ouvre plus le coffre sur cet appareil.',
  recoveryKeyLabel: 'Clé de récupération',
  recoveryKeyHint: '52 lettres et chiffres de votre kit d’urgence ; les espaces et les tirets ne comptent pas.',
  newPassphraseLabel: 'Nouvelle phrase de passe',
  recover: 'Récupérer et déverrouiller',
  recovering: 'Récupération en cours. Cela prend quelques secondes…',
  emptyRecoveryKey: 'Saisissez votre clé de récupération.',
  wrongRecoveryKey: 'Cette clé de récupération n’ouvre pas le coffre.',
  badRecoveryKey: 'Ce n’est pas une clé de récupération : elle compte 52 lettres et chiffres, par groupes de quatre.',
  recoverFailed: 'Le coffre n’a pas pu être récupéré. Rien n’a été modifié : réessayez.',
  backToUnlock: 'Retour au déverrouillage',
  recovered: 'Déverrouillé. Votre nouvelle phrase de passe est définie.',

  homeUnlocked:
    'Votre coffre est ouvert sur cet appareil. Il se verrouille automatiquement après quelques minutes sans activité.',
  lock: 'Verrouiller',
  lockDeferred: 'Verrouillage une fois le travail en cours terminé…',
} as const satisfies Shape<typeof source>
