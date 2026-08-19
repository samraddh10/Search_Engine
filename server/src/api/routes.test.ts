import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_QUERY_LENGTH } from "shared";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePg, pgPool } from "../db/pg.js";
import { processQuery } from "../processing/pipeline.js";
import app, { resultCache } from "./server.js";

// Real Postgres, real DDL, and the real `app` — 3.5 is composition, so a suite that faked the
// pieces it composes would assert the wiring back at itself. The fixture below is inserted the
// same way `queryProcessor.test.ts` inserts its own.
//
// Note on the rate limiters: they are per-process and shared by every test here, so this file
// deliberately stays well under `RATE_LIMITS.search` (60) requests to /search and /statistics
// combined. 5.6 owns limiter edge tests, which need `resetKey` rather than a bigger budget.
afterAll(closePg);

// The stem is computed rather than written down. 3.1 and 3.2 each shipped a test that asserted
// a stem by hand and was wrong about it — `crawler` stems to `crawler`, not `crawl` — and the
// failure looks correct in review.
const STEM = processQuery("documents")[0]!;

const BODIES = [
  "A web crawler downloads documents from the web.",
  "The indexer stores documents in an inverted index.",
];

async function seedCorpus(): Promise<void> {
  const docIds: number[] = [];

  for (const [i, body] of BODIES.entries()) {
    const { rows } = await pgPool.query<{ id: number }>(
      `INSERT INTO documents (url, title, content_text, content_hash, http_status, token_count)
       VALUES ($1, $2, $3, $4, 200, $5)
       RETURNING id`,
      [`https://example.test/page-${i}`, `Page ${i}`, body, `hash-${i}`, body.split(" ").length],
    );
    docIds.push(rows[0]!.id);
  }

  const { rows: termRows } = await pgPool.query<{ id: number }>(
    `INSERT INTO terms (term, doc_freq, surface_form) VALUES ($1, $2, $3) RETURNING id`,
    [STEM, docIds.length, "documents"],
  );
  const termId = termRows[0]!.id;

  for (const docId of docIds) {
    await pgPool.query(
      `INSERT INTO postings (term_id, doc_id, tf, positions) VALUES ($1, $2, 1, $3)`,
      [termId, docId, [4]],
    );
  }

  const avgDocLen = BODIES.reduce((sum, b) => sum + b.split(" ").length, 0) / BODIES.length;
  await pgPool.query(
    `INSERT INTO corpus_stats (id, total_docs, total_tokens, avg_doc_len)
     VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE
        SET total_docs = EXCLUDED.total_docs,
            total_tokens = EXCLUDED.total_tokens,
            avg_doc_len = EXCLUDED.avg_doc_len,
            updated_at = now()`,
    [BODIES.length, String(avgDocLen * BODIES.length), avgDocLen],
  );
}

beforeEach(async () => {
  await pgPool.query("TRUNCATE documents, terms, postings RESTART IDENTITY CASCADE");
  await pgPool.query("DELETE FROM corpus_stats");
  // The cache outlives a request by design and therefore outlives a test. `CorpusVersion`
  // throttles its poll to 30s, so a truncate inside a run does *not* move the version the cache
  // gates on — which is correct in production and would leak one test's corpus into the next
  // here.
  resultCache.clear();
  await seedCorpus();
});

describe("GET /api/search", () => {
  it("returns a ranked page with snippets and match offsets", async () => {
    const res = await request(app).get("/api/search").query({ q: "documents" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      query: "documents",
      status: "ok",
      total: 2,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    });
    expect(res.body.results).toHaveLength(2);

    const [first] = res.body.results;
    expect(first.url).toMatch(/^https:\/\/example\.test\//);
    expect(first.score).toBeGreaterThan(0);
    // 3.2's contract: offsets index into `snippet`, not into the document.
    expect(first.snippet.slice(first.matches[0].start, first.matches[0].end).toLowerCase()).toBe(
      "documents",
    );
  });

  it("echoes the query as typed, not as normalized", async () => {
    const res = await request(app).get("/api/search").query({ q: "DOCUMENTS" });

    // 3.4 excluded `query` from the cached value precisely so a hit cannot answer with another
    // caller's spelling; this is the field being re-attached from the live request.
    expect(res.body.query).toBe("DOCUMENTS");
    expect(res.body.status).toBe("ok");
  });

  it("serves a repeat query from the cache", async () => {
    const first = await request(app).get("/api/search").query({ q: "documents" });
    expect(first.body.results).toHaveLength(2);
    expect(resultCache.size).toBe(1);

    // Delete the corpus out from under the cache. A second request that still answers is being
    // served from memory — the only honest proof of a hit, since a recompute now returns nothing.
    await pgPool.query("TRUNCATE documents, terms, postings RESTART IDENTITY CASCADE");

    const second = await request(app).get("/api/search").query({ q: "documents" });
    expect(second.body).toEqual(first.body);
  });

  it("reports a stopword-only query as no-searchable-terms and does not cache it", async () => {
    const res = await request(app).get("/api/search").query({ q: "the and of" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no-searchable-terms");
    expect(res.body.results).toEqual([]);
    expect(res.body.total).toBe(0);
    // Nothing was paid for, so there is nothing to pay back — and every stopword-only query has
    // the same empty stems, so they would collide onto one key.
    expect(resultCache.size).toBe(0);
  });

  it("reports an unindexed corpus as empty-index rather than as no matches", async () => {
    await pgPool.query("TRUNCATE documents, terms, postings RESTART IDENTITY CASCADE");
    await pgPool.query("DELETE FROM corpus_stats");

    const res = await request(app).get("/api/search").query({ q: "documents" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("empty-index");
    expect(res.body.results).toEqual([]);
  });

  it("ignores k1 and b from the query string", async () => {
    const tuned = await request(app)
      .get("/api/search")
      .query({ q: "documents", k1: 99, b: 0 });

    // Cleared so the second request cannot be answered by the first's entry — the scores being
    // equal has to mean the ranker never saw the knobs, not that the cache hid them.
    resultCache.clear();
    const plain = await request(app).get("/api/search").query({ q: "documents" });

    expect(tuned.body.results[0].score).toBe(plain.body.results[0].score);
  });

  it("defaults page and pageSize from shared/", async () => {
    const res = await request(app).get("/api/search").query({ q: "documents" });

    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it("rejects a missing query", async () => {
    const res = await request(app).get("/api/search");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("q");
  });

  it("rejects a query past MAX_QUERY_LENGTH", async () => {
    const res = await request(app)
      .get("/api/search")
      .query({ q: "d".repeat(MAX_QUERY_LENGTH + 1) });

    expect(res.status).toBe(400);
  });

  it("rejects a pageSize past MAX_PAGE_SIZE", async () => {
    const res = await request(app)
      .get("/api/search")
      .query({ q: "documents", pageSize: MAX_PAGE_SIZE + 1 });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/suggestions", () => {
  it("completes a prefix from surface forms, not stems", async () => {
    const res = await request(app).get("/api/suggestions").query({ q: "doc" });

    expect(res.status).toBe(200);
    // `documents`, not the stem — the whole reason `terms.surface_form` exists.
    expect(res.body).toEqual([{ term: "documents", weight: 2 }]);
  });

  it("returns nothing when the input ends in a space", async () => {
    const res = await request(app).get("/api/suggestions").query({ q: "documents " });

    // Trailing whitespace means no word is being typed. The handler must not trim it away, or it
    // would offer completions for the word the user just finished.
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects a missing query", async () => {
    const res = await request(app).get("/api/suggestions");

    expect(res.status).toBe(400);
  });
});

describe("GET /api/statistics", () => {
  it("returns the corpus row with an ISO timestamp", async () => {
    const res = await request(app).get("/api/statistics");

    const totalTokens = BODIES.reduce((sum, b) => sum + b.split(" ").length, 0);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalDocs: BODIES.length,
      totalTokens,
      avgDocLen: totalTokens / BODIES.length,
    });
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it("reports a never-indexed corpus as null rather than as 1970", async () => {
    await pgPool.query("DELETE FROM corpus_stats");

    const res = await request(app).get("/api/statistics");

    expect(res.body).toEqual({ totalDocs: 0, totalTokens: 0, avgDocLen: 0, updatedAt: null });
  });
});
