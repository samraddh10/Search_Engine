import type { SearchMatch } from "shared";
import { DEFAULT_PAGE_SIZE } from "shared";
import { readCorpusStats } from "../indexer/indexStore.js";
import type { CorpusStats } from "../indexer/invertedIndex.js";
import { processQuery } from "../processing/pipeline.js";
import { rankDocuments, uniqueTerms, type TermPostings } from "../ranking/scorer.js";
import { fetchDocuments, fetchTermPostings, type Queryable } from "../ranking/searchStore.js";
import { buildSnippet } from "./snippets.js";

//Purpose: this is the "order form" — everything a caller (the CLI today, the HTTP API tomorrow) can hand to searchQuery.
export interface SearchOptions {
  query: string;
  page?: number;
  pageSize?: number;
  k1?: number;
  b?: number;
}

/**
 * One hydrated result, ready to render.
 *
 * Structurally `shared`'s `SearchResult` plus `matchedTerms`, which 3.1 kept deliberately: the
 * wire type requires `snippet` and `matches`, and stubbing them would have typechecked, looked
 * implemented, and shipped if 3.2 had slipped. This is the seam it described — the near-identity
 * mapping is where the missing fields got added, and 3.2 added them here rather than in a layer
 * above so that 3.4 caches one complete value instead of choosing between an incomplete one and
 * reaching around the seam.
 */
export interface RankedResult {
  docId: number;
  url: string;
  title: string;
  /** Raw BM25, unbounded and not comparable across queries — 2.4's decision 5. */
  score: number;
  /** What 3.2 highlights from. Records a match even where the term's IDF was ~0. */
  matchedTerms: string[];
  /** Plain text, body only. Untrusted — Phase 4 renders it as text nodes, never as HTML. */
  snippet: string;
  /** Offsets into `snippet`, not into the document. */
  matches: SearchMatch[];
}

/**
 * Zero results is three different situations and the service says which.
 *
 * A stopword-only query, an empty index, and a real query nothing matches all produce an empty
 * list, and collapsing them makes the UI say "no results for *the*" when the honest answer is
 * that the query never reached the index. All three are HTTP 200 when 3.5 renders them: none is
 * a client error, and a stopword-only query is a well-formed request with a boring answer.
 *
 * "No matches" is not a status — it is `ok` with `total: 0`.
 */
export type SearchStatus = "ok" | "empty-index" | "no-searchable-terms";

interface SearchPageBase {
  query: string;
  stems: string[];
  page: number;
  pageSize: number;
  total: number;
  results: RankedResult[];
  terms: TermPostings[];
}

export interface SearchedPage extends SearchPageBase {
  status: "ok" | "empty-index";
  stats: CorpusStats;
}

export interface UnsearchablePage extends SearchPageBase {
  status: "no-searchable-terms";
  stats: null;
}

export type SearchPage = SearchedPage | UnsearchablePage;

/**
 * Run a query: normalize → fetch postings → rank → paginate → hydrate.
 */
//Purpose: run one search end to end and return a value.
export async function searchQuery(db: Queryable, options: SearchOptions): Promise<SearchPage> {
  //Defaulting, not validating. `DEFAULT_PAGE_SIZE` comes from `shared/` so the client's
  //pagination arithmetic and the server's cannot drift; there is deliberately no second copy of
  //the number under `search/`.
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  const stems = uniqueTerms(processQuery(options.query));

  if (stems.length === 0) {
    return { ...blank(options.query, page, pageSize), status: "no-searchable-terms", stats: null };
  }

  //Only reached once we know there's something real to search for. await because it's an async database round-trip.
  const stats = await readCorpusStats(db);

  if (stats.totalDocs === 0) {
    return { ...blank(options.query, page, pageSize, stems), status: "empty-index", stats };
  }

  //The real inverted-index lookup — for each stem, pull its posting list (which documents contain it, term frequency, positions — matches your terms/postings schema).
  const terms = await fetchTermPostings(db, stems);

  //Step 5 — rank
  //computes BM25 for every document that contains at least one stem, and returns them sorted (presumably highest score first).
  const ranked = rankDocuments(terms, stats, { k1: options.k1, b: options.b });

  //Step 5b — paginate
  const offset = (page - 1) * pageSize;
  //A page past the end slices to empty and still reports the true total, which is what a client
  //needs in order to correct itself. No maximum offset is enforced: the full candidate set is
  //scored regardless, so a large one costs a slice that returns nothing.
  const pageOf = ranked.slice(offset, offset + pageSize);

  //Only fetches full document rows (url, title, and per the comment, presumably content_text too) for the ~10-20 documents on this page — not the whole candidate set,
  const documents = await fetchDocuments(
    db,
    pageOf.map((scored) => scored.docId),
  );

  const results: RankedResult[] = [];

  for (const scored of pageOf) {
    const document = documents.get(scored.docId);

    //Narrow race, not a general case: `fetchTermPostings` inner-joins `documents`, so every
    //candidate had a row when it was scored, and only a delete landing between the two queries
    //can get here. Dropping it beats emitting a placeholder URL into an API response — the cost
    //is that `total` transiently overstates by one, which the next query corrects.
    if (document === undefined) continue;

    //Per result, and only for the page being returned — the snippet builder re-runs the
    //processing pipeline over the document's text, which is why it is never handed the whole
    //candidate set. Accepted CPU rather than a schema change: 3.4's cache absorbs repeats, and
    //per-docId memoization is the escape hatch if 5.4 ever measures a reason for one.
    const { snippet, matches } = buildSnippet(
      { title: document.title, contentText: document.contentText },
      scored.matchedTerms,
    );

    results.push({
      docId: scored.docId,
      url: document.url,
      title: document.title,
      score: scored.score,
      matchedTerms: scored.matchedTerms,
      snippet,
      matches,
    });
  }

  //The success return
  return {
    query: options.query,
    status: "ok",
    stems,
    page,
    pageSize,
    total: ranked.length,
    results,
    terms,
    stats,
  };
}

///blank — the shared empty-response builder
function blank(
  query: string,
  page: number,
  pageSize: number,
  stems: string[] = [],
): SearchPageBase {
  return { query, stems, page, pageSize, total: 0, results: [], terms: [] };
}
