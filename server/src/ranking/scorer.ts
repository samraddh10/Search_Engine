//Phase 2.4 — one term against one document is `bm25.ts`; this is a whole query against a whole
//candidate set. Still pure: posting lists arrive as an argument, exactly as `buildIndex` takes
//an iterable and `crawl()` takes a constructed `Frontier`.
import type { CorpusStats } from "../indexer/invertedIndex.js";
import { idf, tfWeight, type Bm25Params } from "./bm25.js";

//Purpose: describes one row of "this document contains this term" — everything tfWeight() needs about a single document for a single term.
export interface ScorablePosting {
  // //docId — which document this posting belongs to.
  docId: number;
  /** `postings.tf`. */
  tf: number;
  /** `documents.token_count`. */
  docLength: number;
}

//Purpose: one query term's entire posting list — the term itself, how many documents contain it overall, and the list of documents that do.
export interface TermPostings {
  /** The stem, as stored in `terms.term`. */
  term: string;
  /** `terms.doc_freq`. */
  docFreq: number;
  postings: readonly ScorablePosting[];
}

//Purpose: the output shape — one document's final ranking result.
export interface ScoredDocument {
 
  docId: number;
  score: number;
  /** Which query stems this document actually contained*/
  matchedTerms: string[];
}

export interface RankOptions extends Bm25Params {
  /** Keep only the best `limit` documents. Omitted means keep all of them. */
  limit?: number;
}

/**
 * Collapse a query's stems to distinct ones, preserving first-occurrence order.
 *
 * `processQuery` deliberately preserves duplicates and the query's own ordering, so
 * `new york new york` arrives as four stems and a naive sum would weight `york` double. On a
 * one-to-five word query a repeat is far more often a slip than an intent, and silently
 * doubling a term's weight because of one is a wrong answer with nothing raised to explain it.
 *
 * The ordered multiset is still the caller's — nothing here mutates it. Deduping also stops the store fetching the same posting list twice.
 */
export function uniqueTerms(stems: readonly string[]): string[] {
  return [...new Set(stems)];
}

/**
 * Score every document that contains at least one query term.
 *
 * **OR, aggregated by summation.** The candidate set is the union of the posting lists; a
 * document needs only one term to be considered, and the terms it *does* contain are summed
 * while missing ones contribute zero rather than a penalty. That is what makes summation do
 * AND's job without AND's failure mode — a document matching all three query terms accumulates
 * three positive contributions and floats above one matching a single term, so precision
 * arrives at the top of the list instead of by way of an empty results page. On a corpus this
 * size strict AND would return nothing most of the time.
 *
 * A zero-weight term still records a match. The document did contain the word; it simply
 * contributed nothing, and dropping it from `matchedTerms` would leave 3.2 unable to highlight
 * a word the user can plainly see in the snippet.
 */
export function scoreDocuments(
  terms: readonly TermPostings[],
  stats: CorpusStats,
  params: Bm25Params = {},
): ScoredDocument[] {
  const byDoc = new Map<number, ScoredDocument>();
  const seen = new Set<string>();

  for (const entry of terms) {
    //Same reasoning as `buildIndex`'s duplicate-id guard: the input is something a caller
    //assembled, and a repeated term would double that term's weight for every document in its
    //posting list — a wrong ordering that no downstream test would trace back to here.
    if (seen.has(entry.term)) {
      throw new Error(`scoreDocuments received term "${entry.term}" twice`);
    }
    seen.add(entry.term);

    //Once per term, not once per posting. A term matching 400 documents would otherwise
    //recompute the same logarithm 400 times.
    const weight = idf(entry.docFreq, stats.totalDocs);

    for (const posting of entry.postings) {
      let scored = byDoc.get(posting.docId);

      if (scored === undefined) {
        scored = { docId: posting.docId, score: 0, matchedTerms: [] };
        byDoc.set(posting.docId, scored);
      }

      scored.score += weight * tfWeight(posting.tf, posting.docLength, stats.avgDocLen, params);
      scored.matchedTerms.push(entry.term);
    }
  }

  return [...byDoc.values()];
}

/**
 * Score, order, and take the best `limit`.
 *
 * **Ties break by `docId`, and that is not cosmetic.** Phase 3 paginates by offset, so two
 * documents with equal scores that can swap order between requests will show the same result
 * on pages 1 and 2 and silently drop another one. The ordering has to be a function of the
 * corpus rather than of evaluation order — the same requirement that made 2.2's surface-form
 * tie-break shortest-then-lexicographic.
 *
 * Sort-then-slice rather than a bounded heap: at this corpus size the candidate set is small
 * enough that the heap would be machinery without a payoff, and swapping it in later changes
 * nothing outside this function.
 *
 * Scores are returned **raw**. BM25 scores are unbounded and not comparable across queries, and
 * normalizing to a percentage of the top hit makes the best result always 100%, which tells a
 * user nothing. What to expose over the API is 3.x's decision, and it can only make it if the
 * real number reaches it.
 */
//Purpose of this function: the actual public entry point most callers will use — runs scoreDocuments, sorts the results best-first, and optionally trims to the top N.
export function rankDocuments(
  terms: readonly TermPostings[],
  stats: CorpusStats,
  options: RankOptions = {},
): ScoredDocument[] {
  const { limit, ...params } = options;

  const scored = scoreDocuments(terms, stats, params);
  scored.sort((a, b) => b.score - a.score || a.docId - b.docId);

  //No pagination here. The scorer computes and the caller decides — 3.1 slices for offset,
  //having asked for `offset + pageSize`.
  return limit === undefined ? scored : scored.slice(0, limit);
}
