import type { shell as source } from '../en/shell.ts'
import type { Shape } from '../index.ts'

/** French for the `shell` namespace; keys, kinds and placeholders match the English source. */
export const shell = {
  skipToContent: 'Aller au contenu',
  navMain: 'Principal',
  navAbout: 'À propos',
  navMore: 'Plus',
  moreTitle: 'Plus',
  moreCompare: 'Comparer les modèles',
  moreArena: 'Arène',
  moreArenaHint: 'Deux modèles répondent à l’aveugle ; vos votes les classent sur cet appareil.',
  moreRoleplay: 'Jeu de rôle',
  moreCharacters: 'Personnages et lorebooks',
  moreCharactersHint: 'Fiches de personnage, lorebooks, réponses rapides et règles regex.',
  moreData: 'Vos données',
  moreTransfer: 'Import et export',
  moreTransferHint: 'Exports Markdown, HTML et JSON, sauvegarde chiffrée, imports depuis d’autres applications.',
  moreStats: 'Utilisation',
  moreStatsHint: 'Jetons et coût par fournisseur et par modèle, calculés sur cet appareil.',
  moreApp: 'Aparté',
  moreProtection: 'Protection par phrase de passe',
  moreAbout: 'À propos de cette version',
  updateReady: 'Une nouvelle version d’Aparté est prête.',
  updateApply: 'Mettre à jour',
  updateWaiting: 'Mise à jour dès que la réponse en cours sera terminée…',
  offlineReady: 'Aparté fonctionne désormais hors ligne.',
  notFoundTitle: 'Rien ici',
  notFoundBody: 'Cette adresse ne correspond à aucun écran d’Aparté.',
  notFoundHome: 'Revenir à l’accueil',
} as const satisfies Shape<typeof source>
