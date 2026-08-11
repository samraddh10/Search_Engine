//The one function both sides of the engine run: 2.2 calls it over `documents.content_text`
//to build the index, and 3.1 calls it over the user's query to look terms up in it. That
//shared use is the whole reason 2.1 is a module rather than four helpers inside the indexer.
//If the two paths ever normalize differently — one stems, the other doesn't; one strips an
//accent, the other doesn't — the engine returns zero results for a query that plainly
//matches, with no error raised anywhere to say so.
import { normalizeToken } from "./normalizer.js";
import { stem } from "./stemmer.js";
import { isStopword } from "./stopwords.js";
import { tokenize } from "./tokenizer.js";

/** A term ready to be indexed, with everything the later phases need to place it. */
export interface ProcessedToken {
  //The stem. This is what goes in `terms.term` and what a query is matched against.
  term: string;
  //The normalized but *unstemmed* spelling. 2.2 tallies these per stem so 2.3 can fill
  //`terms.surface_form`: the index stores "comput", and 3.3's autocomplete has to show the
  //user "computer".
  surface: string;
  //Ordinal in the *full* token stream — assigned before stopwords are dropped, and never
  //renumbered afterwards. Numbering the survivors instead would make "search the engine"
  //and "search engine" both read as positions 0 and 1, so a phrase query for "search
  //engine" would match text that does not contain the phrase. Keeping the gap preserves the
  //distinction, and costs nothing: `positions` is already an int[].
  position: number;
  //Character offsets into the string passed to processText — not into the normalized form,
  //which has a different length. `postings` stores only `position`, so these exist for 3.2:
  //it re-runs this function over `documents.content_text`, finds the token at the position
  //a posting names, and slices the snippet window using these offsets. That only works
  //because this function is deterministic — the same input always yields the same ordinals.
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * Run raw text through the full pipeline: tokenize → normalize → drop stopwords → stem.
 *
 * The returned length is the document's indexed token count — what belongs in
 * `documents.token_count`, and therefore what BM25 uses as document length and what
 * `corpus_stats.avg_doc_len` averages. It counts survivors, not the raw stream, so the
 * length a document is penalized for is the length actually represented in its postings.
 */
export function processText(input: string): ProcessedToken[] {
  const tokens: ProcessedToken[] = [];
  let position = 0;

  for (const raw of tokenize(input)) {
    const surface = normalizeToken(raw.text);

    //Normalization can empty a token outright — a run that was entirely combining marks or
    //punctuation the tokenizer's pattern let through. It never held a searchable term, so it
    //does not consume a position either; a hole in the numbering would look like a dropped
    //stopword to a phrase query and weaken an adjacency check for no reason.
    if (surface === "") continue;

    const current = position++;
    if (isStopword(surface)) continue;

    tokens.push({
      term: stem(surface),
      surface,
      position: current,
      start: raw.start,
      end: raw.end,
    });
  }

  return tokens;
}

/**
 * The query-side entry point: raw query string to the stems to look up in `terms`.
 *
 * Deliberately a thin wrapper over `processText` rather than its own sequence of calls.
 * Reimplementing the four steps here is exactly the drift this module exists to prevent, and
 * it is the kind that typechecks perfectly and fails silently at runtime.
 *
 * Duplicates are preserved and ordering is the query's own, both of which 3.1 needs: a
 * repeated term is a real signal, and positions matter if phrase queries ever land.
 */
export function processQuery(input: string): string[] {
  return processText(input).map((token) => token.term);
}
