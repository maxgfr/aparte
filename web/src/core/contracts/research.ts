/*
 * Contract of Deep research (M5c), a port of the ultrasearch skill's deep-research playbook to the browser: the model
 * plans queries, searches, reads, writes a cited report; the app is the evidence machine (it queries the keyless
 * backends, fuses and de-duplicates their hits, fetches and cleans the pages, numbers the sources) and the judge (it
 * checks every citation of the report against what was actually fetched). Implemented by web/src/core/research/*.ts:
 *
 *   backends.ts  BACKENDS, searchBackend          the keyless search APIs a browser can reach (CORS checked)
 *   fuse.ts      normalizeUrl, fuseHits           identity of a URL, reciprocal-rank fusion, de-duplication
 *   read.ts      readPage, pageText, isWall       fetch a page and keep its readable text
 *   plan.ts      researchDepth, researchInstructions, researchPart   effort to depth, the playbook sent in the turn
 *   tools.ts     researchTools                    `research_search` and `research_read`
 *   history.ts   researchHistory, sourceBlocks, researchTurn, researchProgress
 *   verify.ts    verifyReport, citationsOf        the citation gate
 *   report.ts    reportMarkdown, reportHtml       the report as Markdown and as a self-contained sanitized HTML file
 *
 * A research turn is an ordinary chat turn of the agent loop (contracts/chat.ts): the user message carries the
 * playbook as an `injected: 'research'` text part (the system prompt and the tool set stay frozen), the model calls
 * the research tools (and the provider's own web search, and the MCP search tools the chat declares), and its last
 * answer of the turn, the one without tool calls, is the report. Everything is committed as usual; the verification is
 * recomputed from the committed branch, so it never needs storing.
 *
 * Invariants:
 * - Every request goes through web/src/security/net.ts: the backends with purpose `research` (their hosts are listed
 *   in spec/network-allowlist.json, each one checked to answer a browser with CORS headers), the pages with purpose
 *   `tool`. No key, no cookie, no referrer.
 * - Fetched text is untrusted data. It reaches the model inside delimited `<source>` blocks with a warning, is shown as
 *   text, and never makes the app do anything. A page that tells the model to call a tool changes nothing about
 *   approvals: every tool still runs only as contracts/tools.ts decides.
 * - `research_read` reads only URLs this conversation already surfaced: a search result (`research_search`, the
 *   provider's web search, an MCP search tool), or a URL the user wrote. An instruction planted in a page cannot make
 *   it fetch an address of its choosing, which is why a Deep research chat may allow both research tools for the
 *   conversation when it starts.
 * - Source ids (`S1`, `S2`...) are given once per conversation, in the order pages are first read, and never reused:
 *   the same URL read twice keeps its id.
 * - The verification is deterministic: a citation `[S#]` must name a source read in the turn, a URL written in the
 *   report must be one of those sources, a quoted passage cited to a source must appear in its fetched text (after
 *   normalizing case, whitespace and quotes), and a figure a claim asserts should appear in a source it cites.
 */

import type { Effort } from './ai.ts'

/** The keyless search backends a browser can reach (spec/network-allowlist.json, purpose `research`). */
export type ResearchBackendId =
  | 'wikipedia'
  | 'marginalia'
  | 'mojeek'
  | 'hackernews'
  | 'stackexchange'
  | 'github'
  | 'openalex'
  | 'crossref'
  | 'europepmc'
  | 'pubmed'
  | 'clinicaltrials'
  | 'ietf'

/** What a backend is good for, which the playbook tells the model when to pick it. */
export type ResearchDomain = 'web' | 'encyclopedia' | 'community' | 'code' | 'scholarly' | 'biomedical' | 'standards'

export interface ResearchBackendInfo {
  readonly id: ResearchBackendId
  /** Every origin it contacts (all of them in the allowlist). */
  readonly origins: readonly string[]
  readonly domain: ResearchDomain
  /** On when the user did not choose: the general-purpose ones. */
  readonly byDefault: boolean
}

/** One result of one backend for one query. */
export interface SearchHit {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly backend: ResearchBackendId
  /** A date the backend gives (publication, question, story), ISO 8601 or a year. */
  readonly date?: string
}

/** A fused result: one per identity URL, with every backend that found it. */
export interface FusedHit {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly from: readonly ResearchBackendId[]
  readonly score: number
  readonly date?: string
}

/** How deep a research turn goes, from its effort (`researchDepth`). */
export interface ResearchDepth {
  /** Distinct queries the model is asked for per search round (the most one `research_search` call takes). */
  readonly queries: number
  /** Results asked of each backend for each query. */
  readonly perBackend: number
  /** Fused results one `research_search` call returns. */
  readonly results: number
  /** Pages one `research_read` call reads. */
  readonly reads: number
  /** Characters of a page's text kept for the model. */
  readonly chars: number
  /** Search-and-read rounds the playbook allows (ultrasearch `DEEP_CAPS.maxRounds`). */
  readonly rounds: number
  /** A report should rest on at least this many read sources; fewer is flagged thin. */
  readonly minSources: number
  /**
   * The effort allows too few model calls for a search call and a read call in turn (contracts/tools.ts
   * `stepBudget`): the model searches and reads in the same message (`research_read` with `top`).
   */
  readonly together: boolean
}

/** How a page read ended. `wall`: what came back is a consent, anti-bot or "enable JavaScript" page. */
export type SourceStatus = 'ok' | 'wall' | 'failed'

/** A page `research_read` read, as its result carries it. */
export interface ResearchSource {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly status: SourceStatus
  /** The text the model read (empty unless `ok`). */
  readonly text: string
  /** Why it failed or what stood in for it (`unreachable from a browser (no CORS)`...). */
  readonly note?: string
}

/** A result the turn saw but did not read: a search hit, a source of the provider's web search. */
export interface SnippetSource {
  readonly url: string
  readonly title: string
  readonly snippet: string
}

/** What the committed branch tells the research tools. */
export interface ResearchHistory {
  /** Identity URLs (`normalizeUrl`) `research_read` may read. */
  readonly urls: ReadonlySet<string>
  /** Source ids already given, by identity URL. */
  readonly ids: ReadonlyMap<string, string>
}

/** One research turn of a branch: the question, what was searched and read, and the report. */
export interface ResearchTurn {
  /** The user's own words. */
  readonly question: string
  readonly sources: readonly ResearchSource[]
  readonly snippets: readonly SnippetSource[]
  readonly queries: readonly string[]
  /** The report: the text of the turn's last answer without tool calls; '' while the turn has not written it. */
  readonly report: string
}

/** Where a research turn stands, for the progress panel. */
export type ResearchStep = 'plan' | 'search' | 'read' | 'write' | 'verify' | 'done'

export interface ResearchProgress {
  readonly step: ResearchStep
  readonly queries: number
  /** Distinct results the searches returned. */
  readonly results: number
  /** Pages read (`ok`), and pages that could not be read. */
  readonly read: number
  readonly failed: number
  readonly rounds: number
}

/** A citation's check. `wall`: the source it names was a wall page. */
export type CitationStatus = 'fetched' | 'wall' | 'unknown'

/** A URL written in the report. `snippet`: only a search result, never read. */
export type LinkStatus = 'fetched' | 'snippet' | 'unknown'

export interface Verification {
  /** Every distinct `[S#]` of the report, in first-use order, with how many times it is cited. */
  readonly citations: readonly {
    readonly id: string
    readonly status: CitationStatus
    readonly count: number
    readonly url?: string
  }[]
  readonly links: readonly { readonly url: string; readonly status: LinkStatus }[]
  /** Quoted passages (`"..."` of at least four words) with the sources their unit cites. */
  readonly quotes: readonly {
    readonly text: string
    readonly ids: readonly string[]
    /** null when the unit cites no read source to look in. */
    readonly found: boolean | null
  }[]
  /** Claim units asserting figures that no source they cite contains. */
  readonly numerals: readonly {
    readonly claim: string
    readonly ids: readonly string[]
    readonly missing: readonly string[]
  }[]
  /** Claim units (paragraphs, list items, table rows of six words or more) with neither a citation nor `[M]`. */
  readonly uncited: readonly string[]
  /** `[M]` and `> [model-hint]` flags: knowledge the model added without a source. */
  readonly hints: number
  /** Read sources the report never cites. */
  readonly unused: readonly string[]
  /** The report passes: it cites, every citation and link is a read source, every quote was found. */
  readonly ok: boolean
}

/** Words of the exported report, from the caller, already translated. */
export interface ReportLabels {
  readonly lang: string
  /** A line under the title, already formatted (the model and the date). */
  readonly exported: string
  readonly sources: string
  readonly verification: string
  readonly passed: string
  readonly failed: string
  readonly cited: string
  readonly unknownCitation: string
  readonly unreadLink: string
  readonly quoteMissing: string
  readonly numeralMissing: string
  readonly uncited: string
  readonly hints: string
  readonly wall: string
  readonly notRead: string
}

/** The effort a research turn runs at decides its depth; a model without effort levels runs at `medium`. */
export type ResearchEffort = Effort | null

/** The tool names. */
export const RESEARCH_SEARCH = 'research_search' as const
export const RESEARCH_READ = 'research_read' as const
