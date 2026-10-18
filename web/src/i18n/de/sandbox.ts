import type { sandbox as source } from '../en/sandbox.ts'
import type { Shape } from '../index.ts'

/** German for the `sandbox` namespace; keys, kinds and placeholders match the English source. */
export const sandbox = {
  // The tools
  name_run_js: 'JavaScript ausführen',
  name_run_python: 'Python ausführen',
  hint_run_js:
    'Führt Code, den das Modell schreibt, in einer Sandbox auf diesem Gerät aus, ohne Netzwerk und ohne Zugriff auf Ihre Chats. Fragt vorher.',
  hint_run_python:
    'Führt Python mit numpy, pandas und matplotlib in einer Sandbox auf diesem Gerät aus, ohne Netzwerk und ohne Zugriff auf Ihre Chats. Fragt vorher.',
  iosMemory:
    'Python mit großen Paketen wie pandas oder matplotlib kann auf iPhone und iPad den Arbeitsspeicher aufbrauchen. Der Lauf wird dann gestoppt.',

  // Outputs of a run
  outputs: 'Dateien aus diesem Lauf',
  figure: 'Abbildung {index}',
  imageOutput: 'Bild aus diesem Lauf',
  download: 'Herunterladen',
  downloadLabel: '{name} herunterladen',
  fileMissing: 'Diese Datei ist nicht auf diesem Gerät.',

  // Artifacts
  artifactLabel: 'Artefakt: {title}',
  kind_html: 'HTML-Seite',
  kind_svg: 'SVG-Bild',
  kind_mermaid: 'Diagramm',
  view: 'Ansehen',
  preview: 'Vorschau',
  code: 'Code',
  run: 'Ausführen',
  scriptsHint:
    'Dieses Artefakt enthält Skripte. Sie laufen nur, wenn Sie „Ausführen“ wählen, in einer Sandbox ohne Netzwerk und ohne Zugriff auf Ihre Chats.',
  scriptsOn: 'Skripte laufen in der Sandbox.',
  loading: 'Vorschau wird geladen…',
  failed: 'Die Vorschau konnte nicht angezeigt werden: {message}',
  unavailable: 'Der Diagramm-Renderer konnte auf diesem Gerät nicht geladen werden.',
  frameTitle: 'Vorschau von {title}',
} as const satisfies Shape<typeof source>
