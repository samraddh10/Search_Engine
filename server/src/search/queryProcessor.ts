//Phase 3.1 — the first module under `search/`, and the piece that turns Phase 2's ranking into
//something a request can call.
//
//Everything Phase 2 built is either pure or a program. `bm25.ts`, `scorer.ts` and all of
//`processing/` are functions over values; `ranking/cli.ts` was the only thing that ran a query
//end to end, and it did so as a *process* — importing `db/pg.js`, printing to stdout, returning
//exit codes, closing the pool in a `finally`. None of that survives contact with a request. This
//is the same six steps as a function that computes and returns a value, so 3.5 can call it once
//per request and 3.4 can cache what it returns.
//
//Four of the six steps are calls into code that already exists and is tested. The work here is
//at the edges: pagination, the degenerate cases, and the shape of what comes back.
import { DEFAULT_PAGE_SIZE } from "shared";
import { readCorpusStats } from "../indexer/indexStore.js";
import type { CorpusStats } from "../indexer/invertedIndex.js";
import { processQuery } from "../processing/pipeline.js";
import { rankDocuments, uniqueTerms, type TermPostings } from "../ranking/scorer.js";
import { fetchDocuments, fetchTermPostings, type Queryable } from "../ranking/searchStore.js";

export interface SearchOptions {
  /** The raw query, exactly as typed. `processQuery` is the only thing that touches it. */
  query: string;
  /** 1-based, matching `SearchResponse.page`. Defaults to the first page. */
  page?: number;
  pageSize?: number;
  //On the signature so tests and `npm run search` can turn them; **3.5 must not forward them
  //from the query string**. A ranking knob in anonymous hands is a way to make results look
  //broken, and 3.4's cache key is *normalized query + page* — a caller-supplied `k1` silently
  //becomes a third key dimension and an unbounded way to fill the cache.
  k1?: number;
  b?: number;
}

/**
 * One result, hydrated enough to render a line of output.
 *
 * Deliberately **not** `shared`'s `SearchResult`, which requires `snippet` and `matches`: those
 * are 3.2's and cannot be produced here. Filling them with `""` and `[]` would typecheck, look
 * implemented, and ship if 3.2 slipped. Loosening the wire type to make them optional is worse
 * in the direction that lasts — `shared/` is the contract the client is written against, so
 * every consumer would handle `undefined` forever to paper over a gap that closes next subphase.
 * 3.2 maps this up; the mapping being near-identity is the seam, not ceremony.
 */
export interface RankedResult {
  docId: number;
  url: string;
  title: string;
  /** Raw BM25, unbounded and not comparable across queries — 2.4's decision 5. */
  score: number;
  /** What 3.2 highlights from. Records a match even where the term's IDF was ~0. */
  matchedTerms: string[];
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
  /** Echoed back unchanged; 3.5 puts it in `SearchResponse.query`. */
  query: string;
  /** The stems actually looked up: deduped, in query order. */
  stems: string[];
  page: number;
  pageSize: number;
  /**
   * Documents containing **at least one** stem — the whole candidate set, not this page. That
   * is the honest count for an OR engine, and it is what lets 4.4 render "page 3 of 7".
   */
  total: number;
  results: RankedResult[];
  /**
   * The posting lists as fetched, for `--explain` and 3.5's debug view. Already in hand, so
   * returning it costs nothing and saves the CLI a second round trip.
   */
  terms: TermPostings[];
}

export interface SearchedPage extends SearchPageBase {
  status: "ok" | "empty-index";
  stats: CorpusStats;
}

export interface UnsearchablePage extends SearchPageBase {
  status: "no-searchable-terms";
  //Null rather than zeros: the corpus may well be full, we simply never asked. Reporting
  //`totalDocs: 0` here would make this indistinguishable from "empty-index" to anyone reading
  //the stats instead of the status.
  stats: null;
}

/** Discriminated on `status`, the same shape as 1.1's `FetchResult` and 1.4's `AddResult`. */
export type SearchPage = SearchedPage | UnsearchablePage;

/**
 * Run a query: normalize → fetch postings → rank → paginate → hydrate.
 *
 * Takes a `Queryable` rather than importing `db/pg.js`, exactly as `DocumentStore`, `indexStore`
 * and `searchStore` do — 3.5 is the composition root and the only place that owns connections.
 *
 * Options arrive **already validated**. Boundary validation has two owners, `parseSearchArgs`
 * for the CLI and 3.5's zod middleware for HTTP, and a third copy of the rules in here is a
 * third place that can disagree about what `pageSize = 0` means. Same trust `crawl()` places in
 * the `CrawlOptions` 1.7 hands it.
 */
export async function searchQuery(db: Queryable, options: SearchOptions): Promise<SearchPage> {
  //Defaulting, not validating. `DEFAULT_PAGE_SIZE` comes from `shared/` so the client's
  //pagination arithmetic and the server's cannot drift; there is deliberately no second copy of
  //the number under `search/`.
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  //The same pipeline the indexer ran, by construction rather than by two modules agreeing to be
  //careful — an index built with one tokenizer and queried with another silently returns
  //nothing. `processQuery` keeps duplicates on purpose; `uniqueTerms` is what collapses them, or
  //`new york new york` would weight `york` twice and `scoreDocuments` would throw on the repeat.
  const stems = uniqueTerms(processQuery(options.query));

  //Checked before any I/O, the same way `Frontier.add()` runs every pure check before touching
  //the store. A query with nothing left to look up cannot be answered by the database.
  if (stems.length === 0) {
    return { ...blank(options.query, page, pageSize), status: "no-searchable-terms", stats: null };
  }

  //Read on every query and deliberately not memoized here. It is a single-row read on a primary
  //key, and that row's `updated_at` is the reindex signal 2.5 handed to Phase 3 — caching it
  //inside the query processor would build the exact staleness problem 3.4 exists to solve, one
  //layer below where 3.4 can see it. Read through `readCorpusStats` and never with a raw query:
  //it is the single place `total_tokens` stops being the string node-postgres returns for BIGINT.
  const stats = await readCorpusStats(db);

  if (stats.totalDocs === 0) {
    return { ...blank(options.query, page, pageSize, stems), status: "empty-index", stats };
  }

  const terms = await fetchTermPostings(db, stems);

  //**No `limit`.** 2.4's forward-constraint said to ask for `offset + pageSize` and slice, which
  //would make `total` unknowable — and it saves nothing, because `scoreDocuments` has already
  //built its map over every posting of every term by the time `rankDocuments` sorts. Passing a
  //limit would spare one `Array.slice` and not one comparison. See 3.1 decision 1.
  const ranked = rankDocuments(terms, stats, { k1: options.k1, b: options.b });

  const offset = (page - 1) * pageSize;
  //A page past the end slices to empty and still reports the true total, which is what a client
  //needs in order to correct itself. No maximum offset is enforced: the full candidate set is
  //scored regardless, so a large one costs a slice that returns nothing.
  const pageOf = ranked.slice(offset, offset + pageSize);

  //Only the page being returned is hydrated. `documents` holds `content_text`, so joining the
  //corpus's prose into the scoring query would make the expensive half of a search the half
  //nobody reads.
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

    results.push({
      docId: scored.docId,
      url: document.url,
      title: document.title,
      score: scored.score,
      matchedTerms: scored.matchedTerms,
    });
  }

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

/** The envelope every outcome carries, so the two empty ones don't restate it. */
function blank(
  query: string,
  page: number,
  pageSize: number,
  stems: string[] = [],
): SearchPageBase {
  return { query, stems, page, pageSize, total: 0, results: [], terms: [] };
}
