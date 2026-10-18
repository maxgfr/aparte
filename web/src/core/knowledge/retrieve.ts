/*
 * Hybrid retrieval over passages: a keyword ranking (BM25, through MiniSearch, terms folded as the chat search folds
 * them) and a meaning ranking (cosine similarity of unit-length vectors), fused by reciprocal rank (RRF: the score of
 * a passage is the sum over the rankings of 1 / (RRF_K + rank)). Pure and synchronous once built.
 *
 * Invariants:
 * - Vectors are compared only with a query vector of the same embedder key; a passage without one is ranked by
 *   keywords alone, never by a vector of another model.
 * - A passage enters the meaning ranking only above MIN_SIMILARITY, so a query about nothing in the bases gets
 *   nothing rather than the least unrelated passages.
 */
import MiniSearch from 'minisearch'
import type { Hit } from '../contracts/knowledge.ts'
import type { KnowledgePassage } from '../contracts/workspace.ts'
import { fold } from '../search/search.ts'

/** The usual RRF constant: it damps the weight of the very first ranks. */
export const RRF_K = 60
/** Candidates each ranking contributes before fusion. */
export const CANDIDATES = 50
/** The cosine similarity under which a passage is not related to the query (sentence-embedding models). */
export const MIN_SIMILARITY = 0.2

/** One ranking: passage positions, best first. */
export type Ranking = readonly number[]

/** Fuses rankings by reciprocal rank; ties keep the order of the first ranking, then the position. */
export function fuse(
  rankings: readonly Ranking[],
  k = RRF_K,
): { readonly at: number; readonly score: number; readonly ranks: readonly (number | null)[] }[] {
  const scores = new Map<number, { score: number; ranks: (number | null)[]; first: number }>()
  rankings.forEach((ranking, r) => {
    ranking.forEach((at, i) => {
      let entry = scores.get(at)
      if (entry === undefined) {
        entry = { score: 0, ranks: rankings.map(() => null), first: Number.POSITIVE_INFINITY }
        scores.set(at, entry)
      }
      if (entry.ranks[r] !== null) return
      entry.ranks[r] = i + 1
      entry.score += 1 / (k + i + 1)
      entry.first = Math.min(entry.first, r * 1e9 + i)
    })
  })
  return [...scores]
    .sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first || a[0] - b[0])
    .map(([at, e]) => ({ at, score: e.score, ranks: e.ranks }))
}

/** Dot product of two unit-length vectors: their cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number)
  return s
}

interface Entry {
  readonly passage: KnowledgePassage
  /** Its vector and the embedder key it comes from, or null. */
  readonly vector: { readonly key: string; readonly row: Float32Array } | null
}

/** Passages of one or more documents, searchable by keywords and by meaning. */
export class PassageIndex {
  private readonly entries: Entry[] = []
  private readonly keywords = new MiniSearch<{ id: number; text: string; heading: string; document: string }>({
    fields: ['text', 'heading', 'document'],
    processTerm: (term) => fold(term),
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: 'OR', boost: { heading: 1.5, document: 0.5 } },
  })

  get size(): number {
    return this.entries.length
  }

  /** The embedder keys some passage has a vector of. */
  keys(): Set<string> {
    const out = new Set<string>()
    for (const e of this.entries) if (e.vector) out.add(e.vector.key)
    return out
  }

  /**
   * Adds the passages of one document; `vectors` holds one unit-length row per passage (`dim` floats each) from the
   * embedder `key`, or is null.
   */
  add(passages: readonly KnowledgePassage[], vectors: { key: string; dim: number; data: Float32Array } | null): void {
    const docs = passages.map((passage, i) => {
      const id = this.entries.length
      const row = vectors === null ? null : vectors.data.subarray(i * vectors.dim, (i + 1) * vectors.dim)
      this.entries.push({
        passage,
        vector: row === null || vectors === null ? null : { key: vectors.key, row },
      })
      return { id, text: passage.text, heading: passage.heading ?? '', document: passage.document }
    })
    this.keywords.addAll(docs)
  }

  /** Passage positions by BM25 relevance to `query`. */
  rankKeywords(query: string, limit = CANDIDATES): number[] {
    if (query.trim() === '') return []
    return this.keywords
      .search(query)
      .slice(0, limit)
      .map((r) => r.id as number)
  }

  /** Passage positions by similarity to the query vector of embedder `key`, above MIN_SIMILARITY. */
  rankVectors(key: string, query: Float32Array, limit = CANDIDATES, min = MIN_SIMILARITY): number[] {
    const scored: { at: number; s: number }[] = []
    this.entries.forEach((e, at) => {
      if (e.vector === null || e.vector.key !== key || e.vector.row.length !== query.length) return
      const s = dot(e.vector.row, query)
      if (s >= min) scored.push({ at, s })
    })
    return scored
      .sort((a, b) => b.s - a.s || a.at - b.at)
      .slice(0, limit)
      .map((x) => x.at)
  }

  /** The best `limit` passages: the keyword ranking fused with one meaning ranking per query vector. */
  search(query: string, vectors: ReadonlyMap<string, Float32Array>, limit = 6): Hit[] {
    const keyword = this.rankKeywords(query)
    const meaning = [...vectors].map(([key, v]) => this.rankVectors(key, v))
    // Several embedders give several meaning rankings; each passage has a rank in at most one of them.
    const merged: number[] = []
    for (let i = 0; meaning.some((m) => i < m.length); i++) {
      for (const m of meaning) {
        const at = m[i]
        if (at !== undefined) merged.push(at)
      }
    }
    return fuse([keyword, merged])
      .slice(0, limit)
      .map(({ at, score, ranks }) => ({
        passage: (this.entries[at] as Entry).passage,
        score,
        keywordRank: ranks[0] ?? null,
        vectorRank: ranks[1] ?? null,
      }))
  }
}
