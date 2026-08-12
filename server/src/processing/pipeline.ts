import { normalizeToken } from "./normalizer.js";
import { stem } from "./stemmer.js";
import { isStopword } from "./stopwords.js";
import { tokenize } from "./tokenizer.js";

/** A term ready to be indexed, with everything the later phases need to place it. */
//ProcessedToken — what comes out the other end
//This is the shape of one fully-processed term, and each field exists because a specific later phase needs it:
export interface ProcessedToken {
  //term — the stemmed form. This is literally what gets written into terms.term in Postgres, and what a query is matched against.
  //  "computing" and "computer" both become the same term here, which is the entire point of stemming.
  term: string;

  //surface — the normalized-but-not-stemmed spelling.
  //if a search UI wants to show autocomplete suggestions to a human, you can't show them "comput" — that's not a real word.
  surface: string;
  
  //position — where this token falls in the token stream, used for phrase queries (matching "search engine" as adjacent words,
  //  not just two separate hits anywhere in the document).
  position: number;
  
  //start / end — offsets back into the original input string (not the normalized form, which may have a different length
  //  — the same offset-preservation issue from tokenizer.ts/normalizer.ts).
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

    //assign this token its position now, before checking stopword status, then increment for the next token.
    const current = position++;
    //if (isStopword(surface)) continue; — drop common words after they've already consumed a position number,
    //  so the gap in the sequence is preserved rather than erased.
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

/** The two columns that make up a document's searchable text. */
export interface IndexableFields {
  title: string;
  contentText: string;
}

/**
 * Assemble the exact string that gets indexed — title first, then body.
 *
 * The title has to be indexed: a term that appears only there would otherwise make the page
 * unmatchable by any query, and nothing downstream can recover a page the index never knew
 * about. But `documents.title` and `documents.content_text` are separate columns, so someone
 * has to join them, and *how* they are joined is a contract rather than a detail. 3.2 rebuilds
 * a token's character offsets by re-running `processText` over the document text; if it ran
 * over `content_text` alone while 2.2 indexed title-plus-body, every position would be off by
 * the length of the title in tokens and every snippet would quote the wrong sentence.
 *
 * So this function is the contract, and both sides call it — the same reason `processQuery`
 * is a wrapper over `processText` rather than its own sequence of steps. **3.2 must call this,
 * not read `content_text` directly.**
 *
 * Two consequences worth knowing, both accepted (see the plan's 2.2 agreed design): title
 * tokens count toward `token_count`, so they slightly affect BM25's length normalization; and
 * a phrase query can match across the title/body seam, because a separator cannot consume a
 * position — `processText` skips tokens that normalize to nothing without spending one.
 */
export function indexableText(doc: IndexableFields): string {
  //A blank line, not a space: the tokenizer splits on any non-word run, so this only has to
  //guarantee that the last title word and the first body word cannot fuse into one token.
  return `${doc.title}\n\n${doc.contentText}`;
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
