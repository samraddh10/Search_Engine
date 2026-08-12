//The per-document half of the inverted index. 2.1 emits one ProcessedToken per *occurrence*;
//`postings` stores one row per (term, document). This is the collapse between those two
//shapes, and it is deliberately the only place that walks a document's token stream — so
//everything derivable per document (term frequency, positions, and the surface spellings
//2.3 needs for `terms.surface_form`) is produced in that one pass rather than in three.
import type { ProcessedToken } from "../processing/pipeline.js";

/** Everything one document contributes to one term. */
export interface DocumentPosting {
  tf: number;
  positions: number[];
  //Normalized-but-unstemmed spellings that produced this stem, with counts. The index stores
  //"comput"; 3.3's autocomplete has to show the user "computer". Tallied here because this
  //pass already holds every token — recovering it later means re-tokenizing the whole corpus.
  surfaces: Map<string, number>;
}

/**
 * Group one document's processed tokens into its posting entries, keyed by stem.
 *
 * Insertion order is first appearance in the document, which makes the result deterministic
 * for a deterministic `processText` — a property 2.3's bulk load and the tests both lean on.
 */
//What it does: takes one document's full token array (from processText) and groups it into a Map<stem, DocumentPosting>
//  — one entry per distinct term that appears in this document.
//End result: Map { "crawl" → {tf: 2, positions: [0,3], surfaces: {crawling:1, crawls:1}} }
export function buildDocumentPostings(
  tokens: readonly ProcessedToken[],
): Map<string, DocumentPosting> {
  const postings = new Map<string, DocumentPosting>();

  for (const token of tokens) {
    let posting = postings.get(token.term);

    if (posting === undefined) {
      posting = { tf: 0, positions: [], surfaces: new Map() };
      postings.set(token.term, posting);
    }

    posting.tf += 1;
    //Already ascending: processText walks the text in order and never reorders its output, so
    //sorting here would be spending O(n log n) to restore an ordering we were handed.
    posting.positions.push(token.position);
    posting.surfaces.set(token.surface, (posting.surfaces.get(token.surface) ?? 0) + 1);
  }

  return postings;
}
