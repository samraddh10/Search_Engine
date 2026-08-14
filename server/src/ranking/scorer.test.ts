import { describe, expect, it } from "vitest";
import type { CorpusStats } from "../indexer/invertedIndex.js";
import { rankDocuments, scoreDocuments, uniqueTerms, type TermPostings } from "./scorer.js";

const stats: CorpusStats = { totalDocs: 100, totalTokens: 30_000, avgDocLen: 300 };

function term(name: string, postings: [docId: number, tf: number, len?: number][]): TermPostings {
  return {
    term: name,
    docFreq: postings.length,
    postings: postings.map(([docId, tf, len]) => ({ docId, tf, docLength: len ?? 300 })),
  };
}

describe("uniqueTerms", () => {
  it("drops repeats and keeps first-occurrence order", () => {
    expect(uniqueTerms(["new", "york", "new", "york"])).toEqual(["new", "york"]);
    expect(uniqueTerms(["c", "a", "b", "a"])).toEqual(["c", "a", "b"]);
  });

  it("passes an already-distinct query through untouched", () => {
    expect(uniqueTerms(["web", "crawl"])).toEqual(["web", "crawl"]);
  });

  it("handles an empty query", () => {
    expect(uniqueTerms([])).toEqual([]);
  });
});

describe("scoreDocuments", () => {
  it("scores the union of the posting lists, not the intersection", () => {
    const scored = scoreDocuments([term("web", [[1, 2]]), term("crawl", [[2, 2]])], stats);

    expect(scored.map((result) => result.docId).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  // The reason OR-with-summation does AND's job without AND's failure mode.
  it("ranks a document matching every term above one matching a single term", () => {
    const both = term("web", [[1, 2]]);
    const one = term("crawl", [[1, 2]]);

    const ranked = rankDocuments([both, one, term("index", [[2, 2]])], stats);

    expect(ranked[0]?.docId).toBe(1);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("records which terms a document matched", () => {
    const scored = scoreDocuments([term("web", [[1, 2]]), term("crawl", [[1, 3]])], stats);

    expect(scored[0]?.matchedTerms).toEqual(["web", "crawl"]);
  });

  // A term in every document has an IDF near zero, so it adds nothing — but the document did
  // contain the word, and dropping it from matchedTerms would leave 3.2 unable to highlight a
  // word the user can plainly see in the snippet.
  it("still records a match for a term whose idf is zero", () => {
    const everywhere: TermPostings = {
      term: "the",
      docFreq: stats.totalDocs,
      postings: [{ docId: 1, tf: 40, docLength: 300 }],
    };

    const scored = scoreDocuments([everywhere], stats);

    expect(scored[0]?.matchedTerms).toEqual(["the"]);
    expect(scored[0]!.score).toBeLessThan(0.05);
    expect(scored[0]!.score).toBeGreaterThanOrEqual(0);
  });

  it("gives a rarer term more influence than a common one at equal tf", () => {
    const rare: TermPostings = {
      term: "rare",
      docFreq: 2,
      postings: [{ docId: 1, tf: 3, docLength: 300 }],
    };
    const common: TermPostings = {
      term: "common",
      docFreq: 80,
      postings: [{ docId: 2, tf: 3, docLength: 300 }],
    };

    const ranked = rankDocuments([rare, common], stats);

    expect(ranked[0]?.docId).toBe(1);
  });

  // Same reasoning as buildIndex's duplicate-id guard: a repeated term would double that term's
  // weight across its whole posting list, and no downstream test would trace the wrong ordering
  // back to here.
  it("throws on a repeated term", () => {
    expect(() => scoreDocuments([term("web", [[1, 2]]), term("web", [[2, 2]])], stats)).toThrow(
      /twice/,
    );
  });

  it("returns nothing for an empty query", () => {
    expect(scoreDocuments([], stats)).toEqual([]);
  });

  it("returns zeros rather than NaN against an empty corpus", () => {
    const empty: CorpusStats = { totalDocs: 0, totalTokens: 0, avgDocLen: 0 };
    const scored = scoreDocuments([term("web", [[1, 2, 0]])], empty);

    expect(scored[0]?.score).toBe(0);
    expect(Number.isNaN(scored[0]!.score)).toBe(false);
  });
});

describe("rankDocuments", () => {
  it("sorts by descending score", () => {
    const ranked = rankDocuments(
      [term("web", [[1, 1], [2, 9], [3, 4]])],
      stats,
    );

    expect(ranked.map((result) => result.docId)).toEqual([2, 3, 1]);
  });

  // Phase 3 paginates by offset, so an unstable order shows the same document on pages 1 and 2
  // and silently drops another one.
  it("breaks ties by docId, deterministically", () => {
    const ranked = rankDocuments([term("web", [[7, 3], [2, 3], [5, 3]])], stats);

    expect(ranked.map((result) => result.docId)).toEqual([2, 5, 7]);
    expect(ranked[0]!.score).toBeCloseTo(ranked[2]!.score, 12);
  });

  it("applies the limit", () => {
    const ranked = rankDocuments([term("web", [[1, 1], [2, 9], [3, 4]])], stats, { limit: 2 });

    expect(ranked.map((result) => result.docId)).toEqual([2, 3]);
  });

  it("returns everything when no limit is given", () => {
    expect(rankDocuments([term("web", [[1, 1], [2, 9]])], stats)).toHaveLength(2);
  });

  it("passes k1 and b through to the scorer", () => {
    const postings = term("web", [[1, 5, 60], [2, 5, 900]]);

    // b = 0 removes length normalization, so two documents with equal tf tie and fall back to
    // the docId tie-break; at the default b the short one wins outright.
    const normalized = rankDocuments([postings], stats);
    const flat = rankDocuments([postings], stats, { b: 0 });

    expect(normalized[0]!.score).toBeGreaterThan(normalized[1]!.score);
    expect(flat[0]!.score).toBeCloseTo(flat[1]!.score, 12);
  });
});
