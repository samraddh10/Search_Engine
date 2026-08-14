//Phase 2.4 — the ranking function itself, and the last pure module in Phase 2.
//
//Everything up to here can answer "which documents contain this word?" — that is what `terms`
//and `postings` are. Nothing could answer "which of them is the best answer?", and a search
//engine that returns 400 matches in arbitrary order is not one. This file is the arithmetic
//that turns a set into an ordering; `scorer.ts` applies it across a whole query.
//


export const BM25_DEFAULTS = {
  //How fast term frequency saturates. Lower flattens sooner; the contribution can never exceed
  //`k1 + 1` however many times a word appears.
  k1: 1.2,
  //How much document length is normalized out. 0 disables it entirely, 1 applies it fully.
  b: 0.75,
} as const;

export interface Bm25Params {
  k1?: number;
  b?: number;
}

/**
 * Inverse document frequency: how much a term's presence is worth at all.
 *
 * A word in three documents out of four says almost nothing about which of them you want; a
 * word in one says a great deal. This is the factor that expresses that, and it is the reason
 * a rare query term outranks a common one no matter how often the common one repeats.
 *
 * **The `1 +` inside the log is load-bearing, not a rounding detail.** The classic
 * Robertson–Spärck Jones form is `ln((N − df + 0.5) / (df + 0.5))`, which goes *negative* once
 * `df > N/2` — meaning a document would be penalized for containing a word the user searched
 * for. On a corpus this size that is not an edge case: the dev corpus is four documents, so
 * `df > N/2` is the ordinary case and a term in three of them would push its own matches down
 * the list. Adding 1 floors the result at zero, so a near-universal term stops contributing
 * rather than counting against you.
 */
export function idf(docFreq: number, totalDocs: number): number {
  //Both are unreachable through `scoreDocuments` — a term with no documents has no posting
  //list to score, and an empty corpus has no postings at all — but the alternative to
  //returning zero is `ln` of something negative, which is a `NaN` that would propagate through
  //every score in the result list with nothing raised to say where it came from.
  if (totalDocs <= 0 || docFreq <= 0) return 0;

  //Clamped for the same reason. `doc_freq` counts documents, so it cannot exceed `total_docs`
  //in a consistent index; if a half-written one ever made it so, the numerator would go
  //negative and the log would return NaN rather than a wrong-but-finite score.
  const df = Math.min(docFreq, totalDocs);

  return Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
}


export function tfWeight(
  tf: number,
  docLength: number,
  avgDocLen: number,
  params: Bm25Params = {},
): number {
  //Also guards the `k1 = 0` case, where the denominator would otherwise be 0/0.
  if (tf <= 0) return 0;

  const k1 = params.k1 ?? BM25_DEFAULTS.k1;
  const b = params.b ?? BM25_DEFAULTS.b;

  //A non-positive length falls back to "average", which is neutral — and the direction of the
  //failure is why the guard exists at all. Length 0 would collapse the norm to `1 - b` (0.25 at
  //the default), *shrinking* the denominator and **inflating** the score, so a document with a
  //stale `token_count` would rank above correctly-indexed ones rather than below them.
  //
  //It should be unreachable: 2.3 writes `token_count` and the postings `COPY` in the same
  //transaction, so a document with `token_count = 0` has no postings and can never enter a
  //candidate set. "Unreachable barring corruption" plus "fails by promoting garbage to rank 1"
  //is the combination that earns three lines.
  const ratio = docLength > 0 && avgDocLen > 0 ? docLength / avgDocLen : 1;
  const norm = 1 - b + b * ratio;

  return (tf * (k1 + 1)) / (tf + k1 * norm);
}

/** Everything one (term, document) pair needs to be scored. */
export interface Bm25Input {
  /** Occurrences of the term in this document — `postings.tf`. */
  tf: number;
  /** This document's indexed length — `documents.token_count`. */
  docLength: number;
  /** Documents containing the term — `terms.doc_freq`. */
  docFreq: number;
  /** `corpus_stats.total_docs`. */
  totalDocs: number;
  /** `corpus_stats.avg_doc_len`. */
  avgDocLen: number;
}

/**
 * One term against one document.
 *
 * Split into `idf` and `tfWeight` rather than written as a single expression because the
 * scorer computes IDF once per query term and the TF weight once per posting — a term matching
 * 400 documents would otherwise recompute the same logarithm 400 times.
 */
export function bm25Score(input: Bm25Input, params: Bm25Params = {}): number {
  return (
    idf(input.docFreq, input.totalDocs) *
    tfWeight(input.tf, input.docLength, input.avgDocLen, params)
  );
}
