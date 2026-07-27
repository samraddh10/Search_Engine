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

export interface SearchResponse {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  results: SearchResult[];
}

export interface Suggestion {
  term: string;
  weight: number;
}
