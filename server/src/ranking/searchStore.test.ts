import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePg, pgPool } from "../db/pg.js";
import { fetchDocuments, fetchTermPostings } from "./searchStore.js";

// Real Postgres, real DDL — 0.5's test-DB strategy, the same call indexStore.test.ts and
// store.test.ts make. Everything worth catching in this module is in the SQL: the three-table
// join, the `= ANY($1::text[])` array binding, and the grouping of a flat row set back into
// posting lists. A mocked client could only assert our own beliefs about those back at us.
afterAll(closePg);

beforeEach(async () => {
  await pgPool.query("TRUNCATE documents, terms, postings RESTART IDENTITY CASCADE");
});

async function insertDocument(n: number, tokenCount: number): Promise<number> {
  const { rows } = await pgPool.query<{ id: number }>(
    `INSERT INTO documents (url, title, content_text, content_hash, http_status, token_count)
     VALUES ($1, $2, $3, $4, 200, $5)
     RETURNING id`,
    [
      `https://example.test/page-${n}`,
      `Page ${n}`,
      `Body text for page ${n}.`,
      `hash-${n}`,
      tokenCount,
    ],
  );

  return rows[0]!.id;
}

async function insertTerm(stem: string, docFreq: number, surface = stem): Promise<number> {
  const { rows } = await pgPool.query<{ id: number }>(
    `INSERT INTO terms (term, doc_freq, surface_form) VALUES ($1, $2, $3) RETURNING id`,
    [stem, docFreq, surface],
  );

  return rows[0]!.id;
}

async function insertPosting(
  termId: number,
  docId: number,
  tf: number,
  positions: number[] = [],
): Promise<void> {
  await pgPool.query(
    `INSERT INTO postings (term_id, doc_id, tf, positions) VALUES ($1, $2, $3, $4)`,
    [termId, docId, tf, positions],
  );
}

describe("fetchTermPostings", () => {
  it("returns each term's posting list with the document's length attached", async () => {
    const docA = await insertDocument(1, 120);
    const docB = await insertDocument(2, 340);

    const crawl = await insertTerm("crawl", 2);
    await insertPosting(crawl, docA, 3, [4, 9, 21]);
    await insertPosting(crawl, docB, 1, [7]);

    const terms = await fetchTermPostings(pgPool, ["crawl"]);

    expect(terms).toEqual([
      {
        term: "crawl",
        docFreq: 2,
        postings: [
          { docId: docA, tf: 3, docLength: 120 },
          { docId: docB, tf: 1, docLength: 340 },
        ],
      },
    ]);
  });

  it("groups a flat row set back into one entry per term", async () => {
    const docA = await insertDocument(1, 100);
    const docB = await insertDocument(2, 200);

    const crawl = await insertTerm("crawl", 2);
    const index = await insertTerm("index", 1);

    await insertPosting(crawl, docA, 2);
    await insertPosting(crawl, docB, 5);
    await insertPosting(index, docA, 1);

    const terms = await fetchTermPostings(pgPool, ["crawl", "index"]);

    expect(terms.map((entry) => entry.term)).toEqual(["crawl", "index"]);
    expect(terms[0]!.postings).toHaveLength(2);
    expect(terms[1]!.postings).toHaveLength(1);
  });

  // So --explain output and the tests read in query order rather than in whatever order
  // Postgres felt like returning rows.
  it("returns terms in the order they were asked for", async () => {
    const doc = await insertDocument(1, 100);

    for (const stem of ["alpha", "beta", "gamma"]) {
      const id = await insertTerm(stem, 1);
      await insertPosting(id, doc, 1);
    }

    const terms = await fetchTermPostings(pgPool, ["gamma", "alpha", "beta"]);

    expect(terms.map((entry) => entry.term)).toEqual(["gamma", "alpha", "beta"]);
  });

  it("omits a stem that is not in the index", async () => {
    const doc = await insertDocument(1, 100);
    const crawl = await insertTerm("crawl", 1);
    await insertPosting(crawl, doc, 2);

    const terms = await fetchTermPostings(pgPool, ["crawl", "nonexistent"]);

    expect(terms.map((entry) => entry.term)).toEqual(["crawl"]);
  });

  // Without the dedupe the same posting list would be fetched twice and handed to
  // scoreDocuments, which throws on a repeated term.
  it("dedupes repeated stems", async () => {
    const doc = await insertDocument(1, 100);
    const crawl = await insertTerm("crawl", 1);
    await insertPosting(crawl, doc, 2);

    const terms = await fetchTermPostings(pgPool, ["crawl", "crawl"]);

    expect(terms).toHaveLength(1);
  });

  it("does not query at all for an empty term list", async () => {
    expect(await fetchTermPostings(pgPool, [])).toEqual([]);
  });

  it("reads a token_count of zero as it is, leaving the guard to the scorer", async () => {
    const doc = await insertDocument(1, 0);
    const crawl = await insertTerm("crawl", 1);
    await insertPosting(crawl, doc, 2);

    const terms = await fetchTermPostings(pgPool, ["crawl"]);

    expect(terms[0]!.postings[0]!.docLength).toBe(0);
  });
});

describe("fetchDocuments", () => {
  it("returns the summaries a result page renders from", async () => {
    const docA = await insertDocument(1, 100);
    const docB = await insertDocument(2, 100);

    const found = await fetchDocuments(pgPool, [docB, docA]);

    expect(found.size).toBe(2);
    expect(found.get(docA)).toEqual({
      id: docA,
      url: "https://example.test/page-1",
      title: "Page 1",
      // 3.2 slices the snippet out of this. It rides on the hydration query rather than a
      // second lookup because that query is already bounded by the page size.
      contentText: "Body text for page 1.",
    });
  });

  it("omits ids that no longer exist rather than failing", async () => {
    const doc = await insertDocument(1, 100);

    const found = await fetchDocuments(pgPool, [doc, 99_999]);

    expect([...found.keys()]).toEqual([doc]);
  });

  it("does not query at all for an empty id list", async () => {
    expect((await fetchDocuments(pgPool, [])).size).toBe(0);
  });
});
