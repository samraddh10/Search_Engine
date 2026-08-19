/**
 * The wire shape of a document — what crosses the API boundary as JSON, not the shape of
 * a Postgres row.
 *
 * The distinction matters for `fetchedAt`: the column is TIMESTAMPTZ, and node-postgres
 * parses that into a JS `Date`, so a raw row is NOT assignable to this type. Persistence
 * code must map explicitly (`fetchedAt: row.fetched_at.toISOString()`) rather than
 * casting, or the field will be a Date on the server while every consumer expects an
 * ISO-8601 string.
 */
export interface Document {
  id: number;
  url: string;
  title: string;
  contentText: string;
  contentHash: string;
  httpStatus: number;
  /** ISO-8601 timestamp. */
  fetchedAt: string;
  tokenCount: number;
  lang: string | null;
}

export interface Token {
  term: string;
  position: number;
}

export interface Posting {
  termId: number;
  docId: number;
  tf: number;
  positions: number[];
}

export interface SearchMatch {
  start: number;
  end: number;
}

export interface SearchResult {
  docId: number;
  url: string;
  title: string;
  score: number;
  snippet: string;
  matches: SearchMatch[];
}

/**
 * Why an empty result list is not self-explanatory.
 *
 * A stopword-only query, an unindexed corpus, and a real query nothing matches all produce
 * `results: []`, and a client that cannot tell them apart says "no results for *the*" when the
 * honest answer is that the query never reached the index. 3.1 kept the three distinct through a
 * discriminated union; this is the field that carries the distinction across the wire, which is
 * the boundary it was built to cross.
 *
 * "No matches" is deliberately not one of them — that is `ok` with `total: 0`.
 *
 * All three are HTTP 200. None is a client error, and a stopword-only query is a well-formed
 * request with a boring answer.
 */
export type SearchStatus = "ok" | "empty-index" | "no-searchable-terms";

export interface SearchResponse {
  query: string;
  status: SearchStatus;
  total: number;
  page: number;
  pageSize: number;
  results: SearchResult[];
}

/**
 * `GET /statistics` — the `corpus_stats` row, and nothing else.
 *
 * Deliberately not an observability surface: no cache hit rates, no index size, no uptime.
 * Phase 5.4 adds numbers once it has measured something worth reporting.
 */
export interface Statistics {
  totalDocs: number;
  totalTokens: number;
  avgDocLen: number;
  /**
   * ISO-8601, or `null` when the corpus has never been indexed.
   *
   * The server reads this as epoch milliseconds and reports an unindexed corpus as `0`, which
   * would render as 1970-01-01 — a wrong answer where `null` is a missing one.
   */
  updatedAt: string | null;
}

export interface Suggestion {
  term: string;
  weight: number;
}
