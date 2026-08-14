import { describe, expect, it } from "vitest";
import { BM25_DEFAULTS, bm25Score, idf, tfWeight } from "./bm25.js";

// Pure arithmetic, so no database and no fixture server — the same property that made 2.1's
// and 2.2's suites cheap. Note vitest.config.ts's globalSetup still provisions the test DB for
// the run as a whole, so `npm test` continues to need docker-compose Postgres up.

describe("idf", () => {
  it("gives a rare term more weight than a common one", () => {
    expect(idf(1, 1000)).toBeGreaterThan(idf(500, 1000));
  });

  it("matches a hand-computed value", () => {
    // ln(1 + (1000 - 50 + 0.5) / (50 + 0.5)) = ln(1 + 950.5/50.5)
    expect(idf(50, 1000)).toBeCloseTo(Math.log(1 + 950.5 / 50.5), 12);
  });

  // The whole reason for the `1 +` variant. The textbook Robertson-Sparck Jones form goes
  // negative once df > N/2, which would mean a document is penalized for containing a word the
  // user searched for — and on a four-document dev corpus that is the ordinary case, not an
  // edge case.
  it("never goes negative, however common the term", () => {
    for (const df of [3, 4, 500, 999, 1000]) {
      expect(idf(df, 1000)).toBeGreaterThanOrEqual(0);
    }

    expect(idf(3, 4)).toBeGreaterThanOrEqual(0);
  });

  it("is near zero for a term in every document", () => {
    expect(idf(1000, 1000)).toBeLessThan(0.001);
  });

  it("returns zero rather than NaN for an unindexed term or an empty corpus", () => {
    expect(idf(0, 1000)).toBe(0);
    expect(idf(5, 0)).toBe(0);
  });

  // Unreachable in a consistent index, but a negative numerator would make Math.log return NaN
  // and a NaN propagates through every score in the result list with nothing raised to say so.
  it("clamps a doc_freq larger than the corpus instead of returning NaN", () => {
    expect(Number.isFinite(idf(5000, 1000))).toBe(true);
    expect(idf(5000, 1000)).toBe(idf(1000, 1000));
  });
});

describe("tfWeight", () => {
  const avg = 300;

  it("saturates: 100 occurrences are worth about 2.2 of one", () => {
    const once = tfWeight(1, avg, avg);
    const hundred = tfWeight(100, avg, avg);

    expect(once).toBeCloseTo(1, 6);
    expect(hundred / once).toBeLessThan(2.5);
    expect(hundred / once).toBeGreaterThan(2);
  });

  it("never exceeds k1 + 1", () => {
    for (const tf of [1, 10, 1_000, 1_000_000]) {
      expect(tfWeight(tf, avg, avg)).toBeLessThan(BM25_DEFAULTS.k1 + 1);
    }
  });

  it("is monotonic in tf", () => {
    let previous = 0;

    for (const tf of [1, 2, 3, 10, 50, 500]) {
      const weight = tfWeight(tf, avg, avg);
      expect(weight).toBeGreaterThan(previous);
      previous = weight;
    }
  });

  it("prefers the shorter document at equal tf", () => {
    expect(tfWeight(5, 150, avg)).toBeGreaterThan(tfWeight(5, avg, avg));
    expect(tfWeight(5, avg, avg)).toBeGreaterThan(tfWeight(5, 600, avg));
  });

  it("ignores length entirely at b = 0", () => {
    const short = tfWeight(5, 10, avg, { b: 0 });
    const long = tfWeight(5, 10_000, avg, { b: 0 });

    expect(short).toBe(long);
  });

  it("is zero for a term the document does not contain", () => {
    expect(tfWeight(0, avg, avg)).toBe(0);
  });

  // The guard's direction is the point: length 0 collapses the norm to (1 - b) = 0.25, which
  // shrinks the denominator and *inflates* the score, so an unindexed document would rank
  // above correctly-indexed ones rather than below them.
  it("treats a non-positive length as average rather than inflating the score", () => {
    const neutral = tfWeight(5, avg, avg);

    expect(tfWeight(5, 0, avg)).toBe(neutral);
    expect(tfWeight(5, -10, avg)).toBe(neutral);
    expect(tfWeight(5, avg, 0)).toBe(neutral);
  });
});

describe("bm25Score", () => {
  const base = { tf: 3, docLength: 250, docFreq: 20, totalDocs: 1000, avgDocLen: 300 };

  it("is idf times the tf weight", () => {
    expect(bm25Score(base)).toBeCloseTo(
      idf(base.docFreq, base.totalDocs) * tfWeight(base.tf, base.docLength, base.avgDocLen),
      12,
    );
  });

  it("matches a fully hand-computed value", () => {
    // idf = ln(1 + (1000 - 20 + 0.5) / 20.5) = ln(1 + 980.5/20.5)
    // norm = 1 - 0.75 + 0.75 * (250/300)
    // tf   = 3 * 2.2 / (3 + 1.2 * norm)
    const expectedIdf = Math.log(1 + 980.5 / 20.5);
    const norm = 1 - 0.75 + 0.75 * (250 / 300);
    const expectedTf = (3 * 2.2) / (3 + 1.2 * norm);

    expect(bm25Score(base)).toBeCloseTo(expectedIdf * expectedTf, 12);
  });

  // The one part of the dropped TF-IDF baseline that had engineering value. Setting b = 0 and
  // letting k1 grow collapses the TF term to raw tf, so the whole formula degenerates to
  // tf x IDF — classic TF-IDF. It checks the *shape* of the formula rather than one point on
  // it, which is what catches an inverted term, a misplaced parenthesis, or b applied to the
  // numerator.
  it("degenerates to tf x idf as k1 grows with b = 0", () => {
    const params = { k1: 1e9, b: 0 };

    for (const tf of [1, 4, 25]) {
      const score = bm25Score({ ...base, tf }, params);
      expect(score).toBeCloseTo(tf * idf(base.docFreq, base.totalDocs), 5);
    }
  });

  it("returns zero, not NaN, on an empty corpus", () => {
    const score = bm25Score({ tf: 3, docLength: 0, docFreq: 0, totalDocs: 0, avgDocLen: 0 });

    expect(score).toBe(0);
  });
});
