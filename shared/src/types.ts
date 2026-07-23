export interface Document {
  id: number;
  url: string;
  title: string;
  contentText: string;
  contentHash: string;
  httpStatus: number;
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
