import type { sandbox as source } from '../en/sandbox.ts'
import type { Shape } from '../index.ts'

/** French for the `sandbox` namespace; keys, kinds and placeholders match the English source. */
export const sandbox = {
  // The tools
  name_run_js: 'Exécuter du JavaScript',
  name_run_python: 'Exécuter du Python',
  hint_run_js:
    'Exécute le code écrit par le modèle dans un bac à sable sur cet appareil, sans réseau et sans accès à vos conversations. Demande d’abord.',
  hint_run_python:
    'Exécute Python, avec numpy, pandas et matplotlib, dans un bac à sable sur cet appareil, sans réseau et sans accès à vos conversations. Demande d’abord.',
  iosMemory:
    'Python avec de gros paquets, comme pandas ou matplotlib, peut manquer de mémoire sur iPhone et iPad. L’exécution s’arrête alors.',

  // Outputs of a run
  outputs: 'Fichiers de cette exécution',
  figure: 'Figure {index}',
  imageOutput: 'Image de cette exécution',
  download: 'Télécharger',
  downloadLabel: 'Télécharger {name}',
  fileMissing: 'Ce fichier n’est pas sur cet appareil.',

  // Artifacts
  artifactLabel: 'Artefact : {title}',
  kind_html: 'Page HTML',
  kind_svg: 'Image SVG',
  kind_mermaid: 'Diagramme',
  view: 'Afficher',
  preview: 'Aperçu',
  code: 'Code',
  run: 'Exécuter',
  scriptsHint:
    'Cet artefact contient des scripts. Ils ne s’exécutent que si vous choisissez Exécuter, dans un bac à sable sans réseau et sans accès à vos conversations.',
  scriptsOn: 'Des scripts s’exécutent dans le bac à sable.',
  loading: 'Chargement de l’aperçu…',
  failed: 'L’aperçu n’a pas pu être affiché : {message}',
  unavailable: 'Le moteur de rendu des diagrammes n’a pas pu être chargé sur cet appareil.',
  frameTitle: 'Aperçu de {title}',
} as const satisfies Shape<typeof source>
