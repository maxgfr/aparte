import type { research as source } from '../en/research.ts'
import type { Shape } from '../index.ts'

/** German for the `research` namespace; keys, kinds and placeholders match the English source. */
export const research = {
  // The composer control and its sheet
  button: 'Tiefenrecherche',
  buttonOn: 'Tiefenrecherche: an',
  sheetTitle: 'Tiefenrecherche',
  switchLabel: 'Tiefenrecherche',
  switchHint:
    'Das Modell plant Suchanfragen, durchsucht das Web, liest die besten Seiten und schreibt einen Bericht, in dem jede Aussage auf eine gelesene Seite verweist. Danach prüft die App jede Quellenangabe.',
  switchFrozen:
    'Dieser Chat wurde ohne Tiefenrecherche gestartet, und die Werkzeuge eines Chats sind durch seine erste Nachricht festgelegt. Starten Sie einen neuen Chat, um zu recherchieren.',
  approvalNote:
    'Suchen und das Lesen von Seiten laufen in einem Tiefenrecherche-Chat ohne Nachfrage: Eine Seite kann nur gelesen werden, wenn eine Suche in diesem Chat sie gefunden hat oder Sie ihre Adresse eingegeben haben. Alle anderen Werkzeuge fragen weiterhin nach.',
  depth:
    'Bei diesem Denkaufwand pro Runde bis zu {queries} Suchanfragen und {reads} gelesene Seiten; Runden: {rounds}.',
  depthHint: 'Erhöhen Sie den Denkaufwand für eine tiefere Suche.',
  webSearchOn: 'Zuerst wird die eigene Websuche des Modells verwendet.',
  webSearchOff: 'Dieses Modell hat keine eigene Websuche: Alle Suchen laufen über die Suchdienste unten.',
  sourcesTitle: 'Suchdienste',
  sourcesHint:
    'Kostenlose Dienste, die direkt an einen Browser antworten, ohne Konto. Ihre Anfragen gehen nur an die aktivierten Dienste, sonst nirgendwohin.',
  unreachableTitle: 'Von einem Browser nicht erreichbar',
  unreachableHint:
    'Diese Dienste lehnen Anfragen von einer Webseite ab (kein CORS), daher kann die App sie nicht verwenden.',
  mcpTitle: 'Suchwerkzeuge Ihrer MCP-Server',
  mcpHint: 'Dem Modell auch zum Suchen angeboten. Wie üblich wird vor jeder Ausführung nachgefragt.',
  mcpNone: 'Keiner Ihrer MCP-Server hat ein Suchwerkzeug.',

  // Backends
  backend_wikipedia: 'Wikipedia',
  backend_marginalia: 'Marginalia',
  backend_mojeek: 'Mojeek',
  backend_hackernews: 'Hacker News',
  backend_stackexchange: 'Stack Exchange',
  backend_github: 'GitHub-Issues',
  backend_openalex: 'OpenAlex',
  backend_crossref: 'Crossref',
  backend_europepmc: 'Europe PMC',
  backend_pubmed: 'PubMed',
  backend_clinicaltrials: 'ClinicalTrials.gov',
  backend_ietf: 'IETF Datatracker',
  domain_web: 'Das unabhängige Web',
  domain_encyclopedia: 'Enzyklopädie',
  domain_community: 'Foren und Diskussionen',
  domain_code: 'Softwareprojekte',
  domain_scholarly: 'Forschungsarbeiten',
  domain_biomedical: 'Biomedizinische Literatur und klinische Studien',
  domain_standards: 'Internetstandards',

  // The tools
  name_research_search: 'Im Web suchen',
  name_research_read: 'Seiten lesen',
  hint_research_search: 'Fragt die Suchdienste der Tiefenrecherche ab.',
  hint_research_read: 'Liest Seiten, die eine Suche in diesem Chat gefunden hat.',

  // A research message
  chip: 'Tiefenrecherche',

  // Progress
  progressLabel: 'Fortschritt der Recherche',
  step_plan: 'Planen',
  step_search: 'Suchen',
  step_read: 'Lesen',
  step_write: 'Schreiben',
  step_verify: 'Prüfen',
  stepDone: 'fertig',
  stepNow: 'läuft',
  stepWaiting: 'wartet',
  counts: 'Suchanfragen: {queries} · Ergebnisse: {results} · gelesene Seiten: {read}',
  countsFailed: 'nicht lesbar: {count}',
  rounds: 'Runde {count}',
  stop: 'Recherche stoppen',

  // The report
  reportLabel: 'Recherchebericht',
  verifyTitle: 'Prüfung der Quellenangaben',
  verifyPassed: 'Jede Quellenangabe verweist auf eine gelesene Seite.',
  verifyFailed: 'Einige Quellenangaben stimmen nicht.',
  verifyNoCitation: 'Der Bericht nennt keine Quelle.',
  citationsCount: 'Geprüfte Quellenangaben: {count}',
  unknownCitation: '{id} verweist auf keine Seite, die in dieser Recherche gelesen wurde.',
  wallCitation: '{id} verweist auf eine Seite, die nur eine Cookie-, Einwilligungs- oder Bot-Sperre zeigte.',
  unreadLink: 'Diese Adresse wurde nicht gelesen: {url}',
  snippetLink: 'Nur ein Suchergebnis, nie gelesen: {url}',
  quoteFound: 'Zitat in seiner Quelle gefunden: „{quote}“',
  quoteMissing: 'Zitat in den zitierten Quellen nicht gefunden: „{quote}“',
  numeralMissing: 'Zahlen in den zitierten Quellen nicht gefunden ({figures}): {claim}',
  uncited: 'Aussagen ohne Quellenangabe: {count}',
  hints: 'Aussagen aus dem eigenen Wissen des Modells [M]: {count}',
  unused: 'Gelesene, aber nicht zitierte Seiten: {count}',
  sourcesTitleReport: 'Gelesene Quellen',
  sourceStatus_ok: 'gelesen',
  sourceStatus_wall: 'Sperrseite',
  sourceStatus_failed: 'nicht lesbar',
  exportMarkdown: 'Markdown herunterladen',
  exportHtml: 'HTML herunterladen',
  exportedLine: 'Tiefenrecherche mit {model}, {date}',
  exportVerification: 'Prüfung der Quellenangaben',
  exportPassed: 'Bestanden: Jede Quellenangabe verweist auf eine gelesene Seite.',
  exportFailed: 'Nicht bestanden: Einige Quellenangaben stimmen nicht.',
  exportCited: 'Zitiert',
  exportUnknownCitation: 'Verweist auf keine gelesene Seite',
  exportUnreadLink: 'Adresse nicht gelesen',
  exportQuoteMissing: 'Zitat in seiner Quelle nicht gefunden',
  exportNumeralMissing: 'Zahlen in den zitierten Quellen nicht gefunden',
  exportUncited: 'Aussagen ohne Quellenangabe',
  exportHints: 'Aussagen aus dem eigenen Wissen des Modells',
  exportWall: 'Sperrseite',
  exportNotRead: 'Nicht gelesen',
} as const satisfies Shape<typeof source>
