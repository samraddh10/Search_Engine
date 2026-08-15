import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE } from "shared";
import { closePg, pgPool } from "../db/pg.js";
import type { Queryable } from "../ranking/searchStore.js";
import { searchQuery } from "./queryProcessor.js";

// Real Postgres, real DDL — 0.5's test-DB strategy, the same call `searchStore.test.ts` and
// `indexStore.test.ts` make. The orchestration is thin, but what it orchestrates is a
// three-table join and a corpus-stats read, and a mocked client could only assert our own
// beliefs about those back at us.
afterAll(closePg);

beforeEach(async () => {
  await pgPool.query("TRUNCATE documents, terms, postings RESTART IDENTITY CASCADE");
  await pgPool.query("DELETE FROM corpus_stats");
});

async function insertDocument(n: number, tokenCount: number, title?: string): Promise<number> {
  const { rows } = await pgPool.query<{ id: number }>(
    `INSERT INTO documents (url, title, content_text, content_hash, http_status, token_count)
     VALUES ($1, $2, $3, $4, 200, $5)
     RETURNING id`,
    [
      `https://example.test/page-${n}`,
      title ?? `Page ${n}`,
      `Body text for page ${n}.`,
      `hash-${n}`,
      tokenCount,
    ],
  );

  return rows[0]!.id;
}

async function insertTerm(stem: string, docFreq: number): Promise<number> {
  const { rows } = await pgPool.query<{ id: number }>(
    `INSERT INTO terms (term, doc_freq, surface_form) VALUES ($1, $2, $1) RETURNING id`,
    [stem, docFreq],
  );

  return rows[0]!.id;
}

async function insertPosting(termId: number, docId: number, tf: number): Promise<void> {
  await pgPool.query(`INSERT INTO postings (term_id, doc_id, tf, positions) VALUES ($1, $2, $3, $4)`, [
    termId,
    docId,
    tf,
    [],
  ]);
}

async function setCorpusStats(totalDocs: number, avgDocLen: number): Promise<void> {
  await pgPool.query(
    `INSERT INTO corpus_stats (id, total_docs, total_tokens, avg_doc_len)
     VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE
        SET total_docs = EXCLUDED.total_docs,
            total_tokens = EXCLUDED.total_tokens,
            avg_doc_len = EXCLUDED.avg_doc_len`,
    [totalDocs, String(totalDocs * avgDocLen), avgDocLen],
  );
}

/**
 * A corpus of `count` documents all containing the stem `crawl`, with a descending `tf` so the
 * ranking order is known in advance: document 1 scores highest, document `count` lowest. Every
 * document has the same length, so `tf` is the only thing separating them.
 */
async function seedRankedCorpus(count: number): Promise<void> {
  const crawl = await insertTerm("crawl", count);

  for (let n = 1; n <= count; n++) {
    const docId = await insertDocument(n, 100);
    await insertPosting(crawl, docId, count - n + 1);
  }

  await setCorpusStats(count, 100);
}

describe("searchQuery", () => {
  it("returns a ranked page with each document hydrated", async () => {
    await seedRankedCorpus(3);

    const page = await searchQuery(pgPool, { query: "crawling" });

    expect(page.status).toBe("ok");
    expect(page.stems).toEqual(["crawl"]);
    expect(page.results.map((r) => r.url)).toEqual([
      "https://example.test/page-1",
      "https://example.test/page-2",
      "https://example.test/page-3",
    ]);
    expect(page.results[0]!.title).toBe("Page 1");
    expect(page.results[0]!.matchedTerms).toEqual(["crawl"]);
    // Raw BM25, not normalized to a percentage of the top hit — 2.4's decision 5.
    expect(page.results[0]!.score).toBeGreaterThan(page.results[1]!.score);
  });

  it("defaults to the first page at the shared workspace's page size", async () => {
    await seedRankedCorpus(DEFAULT_PAGE_SIZE + 5);

    const page = await searchQuery(pgPool, { query: "crawl" });

    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(page.results).toHaveLength(DEFAULT_PAGE_SIZE);
  });

  // 3.1 decision 1. If `rankDocuments` were called with `offset + pageSize` as its limit — the
  // constraint 2.4 originally handed forward — this would report 2 and 4.4 could not render
  // "page 1 of 3".
  it("reports the whole candidate set as the total, not the size of the page", async () => {
    await seedRankedCorpus(7);

    const page = await searchQuery(pgPool, { query: "crawl", pageSize: 2 });

    expect(page.total).toBe(7);
    expect(page.results).toHaveLength(2);
  });

  it("paginates by offset without repeating or dropping a document", async () => {
    await seedRankedCorpus(5);

    const first = await searchQuery(pgPool, { query: "crawl", page: 1, pageSize: 2 });
    const second = await searchQuery(pgPool, { query: "crawl", page: 2, pageSize: 2 });
    const third = await searchQuery(pgPool, { query: "crawl", page: 3, pageSize: 2 });

    const seen = [...first.results, ...second.results, ...third.results].map((r) => r.docId);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // Descending tf, so the order across pages is the seeded document order.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("returns an empty page past the end while still reporting the true total", async () => {
    await seedRankedCorpus(3);

    const page = await searchQuery(pgPool, { query: "crawl", page: 50, pageSize: 10 });

    expect(page.results).toEqual([]);
    expect(page.total).toBe(3);
    expect(page.status).toBe("ok");
  });

  it("reports no-searchable-terms for a stopword-only query, without touching the database", async () => {
    await seedRankedCorpus(3);

    let queried = false;
    const spy: Queryable = {
      query: (sql, params) => {
        queried = true;
        return pgPool.query(sql, params as unknown[]) as never;
      },
    };

    const page = await searchQuery(spy, { query: "the and of" });

    expect(page.status).toBe("no-searchable-terms");
    expect(page.stems).toEqual([]);
    expect(page.results).toEqual([]);
    expect(page.total).toBe(0);
    // Null rather than zeros — the corpus is full, we simply never asked.
    expect(page.stats).toBeNull();
    expect(queried).toBe(false);
  });

  it("reports empty-index when nothing has been indexed", async () => {
    await setCorpusStats(0, 0);

    const page = await searchQuery(pgPool, { query: "crawling" });

    expect(page.status).toBe("empty-index");
    // Stems are still computed — the query was searchable, there is just nothing to search.
    expect(page.stems).toEqual(["crawl"]);
    expect(page.results).toEqual([]);
    expect(page.total).toBe(0);
  });

  // The third zero-result case, and deliberately not a status of its own: the query was real and
  // the index was consulted, it simply matched nothing.
  it("reports ok with a total of zero when the stems are absent from the index", async () => {
    await seedRankedCorpus(3);

    const page = await searchQuery(pgPool, { query: "helicopter" });

    expect(page.status).toBe("ok");
    expect(page.stems).toEqual(["helicopt"]);
    expect(page.total).toBe(0);
    expect(page.results).toEqual([]);
  });

  it("dedupes a repeated query term rather than weighting it twice", async () => {
    await seedRankedCorpus(2);

    const once = await searchQuery(pgPool, { query: "crawl" });
    // Three words, one stem. Note `crawler` is deliberately *not* among them: Porter understems
    // it to `crawler`, which 2.1 records as a known limitation rather than a bug.
    const twice = await searchQuery(pgPool, { query: "crawl crawling crawls" });

    expect(twice.stems).toEqual(["crawl"]);
    expect(twice.results[0]!.score).toBeCloseTo(once.results[0]!.score, 10);
  });

  it("returns the posting lists it fetched, so --explain needs no second round trip", async () => {
    await seedRankedCorpus(3);

    const page = await searchQuery(pgPool, { query: "crawl" });

    expect(page.terms).toHaveLength(1);
    expect(page.terms[0]!.term).toBe("crawl");
    expect(page.terms[0]!.docFreq).toBe(3);
    expect(page.terms[0]!.postings).toHaveLength(3);
  });

  it("passes BM25 parameters through to the scorer", async () => {
    await seedRankedCorpus(2);

    const tuned = await searchQuery(pgPool, { query: "crawl", k1: 0.1 });
    const untuned = await searchQuery(pgPool, { query: "crawl" });

    // Lower k1 saturates term frequency sooner, so the tf=2 document's lead over tf=1 shrinks.
    const tunedGap = tuned.results[0]!.score - tuned.results[1]!.score;
    const untunedGap = untuned.results[0]!.score - untuned.results[1]!.score;

    expect(tunedGap).toBeLessThan(untunedGap);
  });

  // Unreachable through the pool — `fetchTermPostings` inner-joins `documents`, so a candidate
  // always had a row when it was scored. Only a delete landing between the two queries can do
  // it, which is why this is the one test that stubs rather than using the real client.
  it("drops a document that vanished between ranking and hydration", async () => {
    await seedRankedCorpus(2);

    const vanishing: Queryable = {
      query: (sql, params) =>
        sql.includes("FROM documents WHERE id")
          ? Promise.resolve({ rows: [], rowCount: 0 })
          : (pgPool.query(sql, params as unknown[]) as never),
    };

    const page = await searchQuery(vanishing, { query: "crawl" });

    expect(page.results).toEqual([]);
    // The candidate set was real, so the total still reflects it. Overstating by the number of
    // rows that disappeared is the recoverable direction; a placeholder URL in the response
    // would not be.
    expect(page.total).toBe(2);
  });
});
