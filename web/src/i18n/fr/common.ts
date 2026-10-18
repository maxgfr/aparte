import type { common as source } from '../en/common.ts'
import type { Shape } from '../index.ts'

/** French for the `common` namespace; keys, kinds and placeholders match the English source. */
export const common = {
  appName: 'Aparté',
  close: 'Fermer',
  back: 'Retour',
  reload: 'Recharger',
  later: 'Plus tard',
  loading: 'Chargement…',
  yes: 'Oui',
  no: 'Non',
  unknown: 'Inconnu',
  opensInNewTab: '(s’ouvre dans un nouvel onglet)',
  screenFailedTitle: 'Cet écran n’a pas pu se charger',
  screenFailedBody:
    'Aparté vient peut-être d’être mis à jour, ou le réseau a été coupé pendant le chargement. Rien sur cet appareil n’a été modifié.',
} as const satisfies Shape<typeof source>
