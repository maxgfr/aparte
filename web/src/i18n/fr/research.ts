import type { research as source } from '../en/research.ts'
import type { Shape } from '../index.ts'

/** French for the `research` namespace; keys, kinds and placeholders match the English source. */
export const research = {
  // The composer control and its sheet
  button: 'Recherche approfondie',
  buttonOn: 'Recherche approfondie activée',
  sheetTitle: 'Recherche approfondie',
  switchLabel: 'Recherche approfondie',
  switchHint:
    'Le modèle planifie des requêtes, cherche sur le web, lit les meilleures pages et rédige un rapport où chaque affirmation cite une page lue. L’application vérifie ensuite chaque citation.',
  switchFrozen:
    'Cette conversation a commencé sans Recherche approfondie, et les outils d’une conversation sont fixés par son premier message. Démarrez une nouvelle conversation pour lancer une recherche.',
  approvalNote:
    'La recherche et la lecture de pages s’exécutent sans demande dans une conversation en Recherche approfondie : une page ne peut être lue que si une recherche de cette conversation l’a trouvée, ou si vous avez saisi son adresse. Tous les autres outils demandent toujours une autorisation.',
  depth: 'Avec cet effort : jusqu’à {queries} requêtes et {reads} pages lues par tour ; nombre de tours : {rounds}.',
  depthHint: 'Augmentez l’effort pour une recherche plus poussée.',
  webSearchOn: 'La recherche web propre au modèle est utilisée en premier.',
  webSearchOff:
    'Ce modèle n’a pas de recherche web propre : les services de recherche ci-dessous font tout le travail.',
  sourcesTitle: 'Services de recherche',
  sourcesHint:
    'Services gratuits qui répondent directement à un navigateur, sans compte. Vos requêtes ne vont qu’à ceux qui sont activés ; aucun autre n’en reçoit.',
  unreachableTitle: 'Inaccessibles depuis un navigateur',
  unreachableHint:
    'Ces services refusent les requêtes provenant d’une page web (pas de CORS) : l’application ne peut donc pas les utiliser.',
  mcpTitle: 'Outils de recherche de vos serveurs MCP',
  mcpHint:
    'Proposés au modèle pour la recherche aussi. Ils demandent une autorisation avant chaque exécution, comme d’habitude.',
  mcpNone: 'Aucun de vos serveurs MCP ne propose d’outil de recherche.',

  // Backends
  backend_wikipedia: 'Wikipedia',
  backend_marginalia: 'Marginalia',
  backend_mojeek: 'Mojeek',
  backend_hackernews: 'Hacker News',
  backend_stackexchange: 'Stack Exchange',
  backend_github: 'Issues GitHub',
  backend_openalex: 'OpenAlex',
  backend_crossref: 'Crossref',
  backend_europepmc: 'Europe PMC',
  backend_pubmed: 'PubMed',
  backend_clinicaltrials: 'ClinicalTrials.gov',
  backend_ietf: 'IETF Datatracker',
  domain_web: 'Le web indépendant',
  domain_encyclopedia: 'Encyclopédies',
  domain_community: 'Forums et discussions',
  domain_code: 'Projets logiciels',
  domain_scholarly: 'Articles de recherche',
  domain_biomedical: 'Littérature biomédicale et essais cliniques',
  domain_standards: 'Normes de l’Internet',

  // The tools
  name_research_search: 'Rechercher sur le web',
  name_research_read: 'Lire des pages',
  hint_research_search: 'Interroge les services de recherche de la Recherche approfondie.',
  hint_research_read: 'Lit des pages trouvées par une recherche de cette conversation.',

  // A research message
  chip: 'Recherche approfondie',

  // Progress
  progressLabel: 'Progression de la recherche',
  step_plan: 'Planifier',
  step_search: 'Rechercher',
  step_read: 'Lire',
  step_write: 'Rédiger',
  step_verify: 'Vérifier',
  stepDone: 'terminé',
  stepNow: 'en cours',
  stepWaiting: 'en attente',
  counts: 'Requêtes : {queries} · résultats : {results} · pages lues : {read}',
  countsFailed: 'Impossible de lire : {count}',
  rounds: 'Tour {count}',
  stop: 'Arrêter la recherche',

  // The report
  reportLabel: 'Rapport de recherche',
  verifyTitle: 'Vérification des citations',
  verifyPassed: 'Chaque citation renvoie à une page lue.',
  verifyFailed: 'Certaines citations ne tiennent pas.',
  verifyNoCitation: 'Le rapport ne cite aucune source.',
  citationsCount: 'Citations vérifiées : {count}',
  unknownCitation: '{id} ne désigne aucune page lue dans cette recherche.',
  wallCitation: '{id} cite une page qui était un écran de cookies, de consentement ou anti-robot.',
  unreadLink: 'Cette adresse n’a pas été lue : {url}',
  snippetLink: 'Seul un résultat de recherche, jamais lu : {url}',
  quoteFound: 'Citation retrouvée dans sa source : « {quote} »',
  quoteMissing: 'Citation introuvable dans les sources qu’elle cite : « {quote} »',
  numeralMissing: 'Chiffres introuvables dans les sources citées ({figures}) : {claim}',
  uncited: 'Affirmations sans citation : {count}',
  hints: 'Affirmations tirées des connaissances du modèle [M] : {count}',
  unused: 'Pages lues mais non citées : {count}',
  sourcesTitleReport: 'Sources lues',
  sourceStatus_ok: 'lue',
  sourceStatus_wall: 'page de blocage',
  sourceStatus_failed: 'illisible',
  exportMarkdown: 'Télécharger le Markdown',
  exportHtml: 'Télécharger le HTML',
  exportedLine: 'Recherche approfondie avec {model}, {date}',
  exportVerification: 'Vérification des citations',
  exportPassed: 'Réussie : chaque citation renvoie à une page lue.',
  exportFailed: 'Échouée : certaines citations ne tiennent pas.',
  exportCited: 'Cité',
  exportUnknownCitation: 'Désigne une page non lue',
  exportUnreadLink: 'Adresse non lue',
  exportQuoteMissing: 'Citation introuvable dans sa source',
  exportNumeralMissing: 'Chiffres introuvables dans les sources citées',
  exportUncited: 'Affirmations sans citation',
  exportHints: 'Affirmations tirées des connaissances du modèle',
  exportWall: 'Page de blocage',
  exportNotRead: 'Non lue',
} as const satisfies Shape<typeof source>
