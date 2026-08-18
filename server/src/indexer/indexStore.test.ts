import type { PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePg, pgPool } from "../db/pg.js";
import {
  readCorpusStats,
  streamDocuments,
  writeIndex,
  type IndexWriteStats,
} from "./indexStore.js";
import { buildIndex, type BuiltIndex, type IndexedTerm } from "./invertedIndex.js";

// Real Postgres, real DDL — 0.5's test-DB strategy, and the same call store.test.ts makes.
// Everything worth catching in this module is in the SQL, the COPY encoding and the
// transaction boundary; a mocked client could only assert our own beliefs about those back
// at us, and the BIGINT round trip in particular exists precisely because the driver does
// something we would not have predicted.
afterAll(closePg);

beforeEach(async () => {
  await pgPool.query("TRUNCATE documents, terms, postings RESTART IDENTITY CASCADE");
  await pgPool.query(
    "UPDATE corpus_stats SET total_docs = 0, total_tokens = 0, avg_doc_len = 0 WHERE id = 1",
  );
});

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pgPool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// Array.fromAsync exists on Node 22 but not in the ES2022 lib this project targets, and
// widening the lib for one test convenience would change what the whole server may call.
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

async function insertDocuments(count: number): Promise<number[]> {
  const ids: number[] = [];

  for (let n = 1; n <= count; n++) {
    const { rows } = await pgPool.query<{ id: number }>(
      `INSERT INTO documents (url, title, content_text, content_hash, http_status, token_count)
       VALUES ($1, $2, $3, $4, 200, 0)
       RETURNING id`,
      [
        `https://example.test/page-${n}`,
        `Page ${n}`,
        `Body text for page ${n} about crawling and indexing.`,
        `hash-${n}`,
      ],
    );

    ids.push(rows[0]!.id);
  }

  return ids;
}

function term(overrides: Partial<IndexedTerm> & { term: string }): IndexedTerm {
  return {
    surfaceForm: overrides.term,
    postings: [],
    ...overrides,
  };
}

function builtIndex(terms: IndexedTerm[], docLengths: Map<number, number>): BuiltIndex {
  const totalTokens = [...docLengths.values()].reduce((sum, n) => sum + n, 0);
  const totalDocs = docLengths.size;

  return {
    terms: new Map(terms.map((entry) => [entry.term, entry])),
    docLengths,
    stats: {
      totalDocs,
      totalTokens,
      avgDocLen: totalDocs === 0 ? 0 : totalTokens / totalDocs,
    },
  };
}

interface TermRow extends Record<string, unknown> {
  id: number;
  term: string;
  doc_freq: number;
  surface_form: string | null;
}

interface PostingRow extends Record<string, unknown> {
  term: string;
  doc_id: number;
  tf: number;
  positions: number[];
}

async function termRows(): Promise<TermRow[]> {
  const { rows } = await pgPool.query<TermRow>("SELECT * FROM terms ORDER BY term");
  return rows;
}

async function postingRows(): Promise<PostingRow[]> {
  const { rows } = await pgPool.query<PostingRow>(
    `SELECT t.term, p.doc_id, p.tf, p.positions
       FROM postings p
       JOIN terms t ON t.id = p.term_id
      ORDER BY t.term, p.doc_id`,
  );
  return rows;
}

describe("streamDocuments", () => {
  it("yields every document exactly once across batch boundaries", async () => {
    const ids = await insertDocuments(5);

    const seen: number[] = [];
    // A batch size that does not divide the corpus evenly is the case worth pinning: an
    // off-by-one in the keyset cursor would either skip the first row of each page or
    // repeat the last one, and both look fine with a batch size of 1 or of "all of them".
    for await (const doc of streamDocuments(pgPool, { batchSize: 2 })) {
      seen.push(doc.id);
    }

    expect(seen).toEqual(ids);
  });

  it("maps the row shape onto IndexableDocument", async () => {
    await insertDocuments(1);

    const [doc] = await collect(streamDocuments(pgPool));

    expect(doc).toEqual({
      id: expect.any(Number),
      title: "Page 1",
      contentText: "Body text for page 1 about crawling and indexing.",
    });
  });

  it("yields nothing on an empty corpus", async () => {
    const seen = await collect(streamDocuments(pgPool));

    expect(seen).toEqual([]);
  });
});

describe("writeIndex", () => {
  it("writes terms, postings, token counts and corpus stats", async () => {
    const [a, b] = (await insertDocuments(2)) as [number, number];

    const index = builtIndex(
      [
        term({
          term: "crawl",
          surfaceForm: "crawler",
          postings: [
            { docId: a, tf: 2, positions: [0, 7] },
            { docId: b, tf: 1, positions: [3] },
          ],
        }),
        term({
          term: "index",
          surfaceForm: "indexing",
          postings: [{ docId: b, tf: 1, positions: [4] }],
        }),
      ],
      new Map([
        [a, 10],
        [b, 6],
      ]),
    );

    const stats = await withClient((client) => writeIndex(client, index));

    expect(stats).toEqual<IndexWriteStats>({
      terms: 2,
      postings: 3,
      documents: 2,
      totalTokens: 16,
      avgDocLen: 8,
    });

    expect(await termRows()).toEqual([
      // doc_freq is the posting list's length — 2.2's decision that it is never a second
      // tracked field, carried through to the column.
      { id: expect.any(Number), term: "crawl", doc_freq: 2, surface_form: "crawler" },
      { id: expect.any(Number), term: "index", doc_freq: 1, surface_form: "indexing" },
    ]);

    expect(await postingRows()).toEqual([
      { term: "crawl", doc_id: a, tf: 2, positions: [0, 7] },
      { term: "crawl", doc_id: b, tf: 1, positions: [3] },
      { term: "index", doc_id: b, tf: 1, positions: [4] },
    ]);

    const { rows } = await pgPool.query<{ id: number; token_count: number }>(
      "SELECT id, token_count FROM documents ORDER BY id",
    );
    expect(rows).toEqual([
      { id: a, token_count: 10 },
      { id: b, token_count: 6 },
    ]);

    expect(await readCorpusStats(pgPool)).toMatchObject({
      totalDocs: 2,
      totalTokens: 16,
      avgDocLen: 8,
    });
  });

  // `updated_at` is Phase 3's reindex signal: 3.3's suggest index and 3.4's cache both poll it
  // to notice that this job — which runs in an entirely different process — has rebuilt
  // underneath them. Nothing read the column until 3.3, so a write that quietly stopped
  // refreshing it would strand every API instance on a stale index with nothing raised.
  it("moves corpus_stats.updated_at on every write, and reports it as epoch milliseconds", async () => {
    const [a] = (await insertDocuments(1)) as [number];
    const index = builtIndex(
      [term({ term: "crawl", postings: [{ docId: a, tf: 1, positions: [0] }] })],
      new Map([[a, 1]]),
    );

    const before = (await readCorpusStats(pgPool)).updatedAt;
    await withClient((client) => writeIndex(client, index));
    const after = (await readCorpusStats(pgPool)).updatedAt;

    // A number, not the `Date` node-postgres hands back: `new Date(x) !== new Date(x)` is
    // always true, so a poll comparing `Date`s would see a reindex on every single tick.
    expect(typeof after).toBe("number");
    expect(after).toBeGreaterThan(before);
  });

  // The COPY path's one real encoding decision: `positions` is serialized by hand as a
  // Postgres array literal, so an off-by-one in the braces or a stray separator would land
  // as a silently different array rather than as an error.
  it("round-trips position arrays through COPY, including an empty one", async () => {
    const [a] = (await insertDocuments(1)) as [number];

    const index = builtIndex(
      [
        term({ term: "long", postings: [{ docId: a, tf: 4, positions: [0, 1, 12, 3000] }] }),
        term({ term: "none", postings: [{ docId: a, tf: 0, positions: [] }] }),
      ],
      new Map([[a, 4]]),
    );

    await withClient((client) => writeIndex(client, index));

    expect(await postingRows()).toEqual([
      { term: "long", doc_id: a, tf: 4, positions: [0, 1, 12, 3000] },
      { term: "none", doc_id: a, tf: 0, positions: [] },
    ]);
  });

  // Why `terms` is on the parameterized-INSERT path and not the COPY one. Tabs, newlines
  // and backslashes are COPY's text-format delimiters and escape character; on this path the
  // driver owns the escaping, so they survive. 2.1 would not currently emit such a stem —
  // this pins the reason the split exists, so a later "make it all COPY for speed" change
  // has something to fail against.
  it("stores terms containing COPY's delimiter characters", async () => {
    const [a] = (await insertDocuments(1)) as [number];

    const nasty = "tab\tnewline\nbackslash\\end";

    const index = builtIndex(
      [term({ term: nasty, surfaceForm: nasty, postings: [{ docId: a, tf: 1, positions: [0] }] })],
      new Map([[a, 1]]),
    );

    await withClient((client) => writeIndex(client, index));

    const rows = await termRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.term).toBe(nasty);
    expect(rows[0]!.surface_form).toBe(nasty);
  });

  it("replaces the previous index rather than merging into it", async () => {
    const [a, b] = (await insertDocuments(2)) as [number, number];

    const first = builtIndex(
      [
        term({ term: "gone", postings: [{ docId: a, tf: 1, positions: [0] }] }),
        term({ term: "stay", postings: [{ docId: a, tf: 1, positions: [1] }] }),
      ],
      new Map([
        [a, 2],
        [b, 0],
      ]),
    );

    await withClient((client) => writeIndex(client, first));

    const second = builtIndex(
      [
        term({
          term: "stay",
          postings: [
            { docId: a, tf: 1, positions: [1] },
            { docId: b, tf: 5, positions: [0, 2] },
          ],
        }),
      ],
      new Map([
        [a, 2],
        [b, 7],
      ]),
    );

    await withClient((client) => writeIndex(client, second));

    // The whole argument against upserting: "gone" is absent from the second build, and a
    // merge would leave it behind holding a doc_freq that still votes in every IDF.
    const terms = await termRows();
    expect(terms.map((row) => row.term)).toEqual(["stay"]);
    expect(terms[0]!.doc_freq).toBe(2);

    expect(await postingRows()).toEqual([
      { term: "stay", doc_id: a, tf: 1, positions: [1] },
      { term: "stay", doc_id: b, tf: 5, positions: [0, 2] },
    ]);

    expect(await readCorpusStats(pgPool)).toMatchObject({
      totalDocs: 2,
      totalTokens: 9,
      avgDocLen: 4.5,
    });
  });

  it("empties the index for an empty corpus instead of leaving the old one", async () => {
    const [a] = (await insertDocuments(1)) as [number];

    await withClient((client) =>
      writeIndex(
        client,
        builtIndex(
          [term({ term: "old", postings: [{ docId: a, tf: 1, positions: [0] }] })],
          new Map([[a, 1]]),
        ),
      ),
    );

    await withClient((client) => writeIndex(client, builtIndex([], new Map())));

    expect(await termRows()).toEqual([]);
    expect(await postingRows()).toEqual([]);
    // 0 rather than NaN, the guard 2.2 put in buildIndex, carried into the column BM25 reads.
    expect(await readCorpusStats(pgPool)).toMatchObject({
      totalDocs: 0,
      totalTokens: 0,
      avgDocLen: 0,
    });
  });

  // The reason the whole write is one transaction. A partial flush would leave the API
  // serving an index whose postings and doc_freqs disagree, with nothing raised to say so.
  it("rolls back and leaves the previous index intact when the write fails", async () => {
    const [a] = (await insertDocuments(1)) as [number];

    const good = builtIndex(
      [term({ term: "keep", postings: [{ docId: a, tf: 1, positions: [0] }] })],
      new Map([[a, 1]]),
    );

    await withClient((client) => writeIndex(client, good));

    // A posting for a document id that does not exist: postings.doc_id is a foreign key, so
    // this fails inside the COPY, after the DELETEs and the term INSERT have already run.
    const broken = builtIndex(
      [term({ term: "broken", postings: [{ docId: 999_999, tf: 1, positions: [0] }] })],
      new Map([[a, 1]]),
    );

    await expect(withClient((client) => writeIndex(client, broken))).rejects.toThrow();

    expect((await termRows()).map((row) => row.term)).toEqual(["keep"]);
    expect(await postingRows()).toEqual([{ term: "keep", doc_id: a, tf: 1, positions: [0] }]);
    expect(await readCorpusStats(pgPool)).toMatchObject({
      totalDocs: 1,
      totalTokens: 1,
      avgDocLen: 1,
    });
  });

  it("writes a corpus larger than one batch", async () => {
    const ids = await insertDocuments(12);

    const index = builtIndex(
      ids.map((id, n) => term({ term: `t${n}`, postings: [{ docId: id, tf: 1, positions: [n] }] })),
      new Map(ids.map((id) => [id, 3])),
    );

    // Batches of 5 across 12 terms and 12 documents: two full flushes and a partial one, so
    // a `flush()` that forgot the trailing remainder would drop the last two rows.
    const stats = await withClient((client) => writeIndex(client, index, { batchSize: 5 }));

    expect(stats.terms).toBe(12);
    expect(stats.postings).toBe(12);
    expect(stats.documents).toBe(12);
    expect(await termRows()).toHaveLength(12);
    expect(await postingRows()).toHaveLength(12);
  });
});

describe("buildIndex over streamDocuments", () => {
  // The end-to-end shape 2.3's CLI actually runs: real rows in, real rows out, with 2.1 and
  // 2.2 in between rather than a hand-written BuiltIndex.
  it("indexes the corpus and stores stats that agree with the documents table", async () => {
    const ids = await insertDocuments(3);

    const index = await buildIndex(streamDocuments(pgPool, { batchSize: 2 }));
    const stats = await withClient((client) => writeIndex(client, index));

    expect(stats.documents).toBe(3);
    expect(stats.terms).toBeGreaterThan(0);

    // "crawling" and "indexing" appear in every fixture body, so their stems are in every
    // document — which makes doc_freq a number the fixture pins rather than an opaque one.
    const { rows } = await pgPool.query<{ doc_freq: number }>(
      "SELECT doc_freq FROM terms WHERE term = $1",
      ["crawl"],
    );
    expect(rows[0]!.doc_freq).toBe(3);

    // token_count is what BM25's length normalization divides by, and 1.6 zeroes it on every
    // re-crawl — so a build that skipped the writeback leaves every document looking empty.
    const counts = await pgPool.query<{ token_count: number }>(
      "SELECT token_count FROM documents ORDER BY id",
    );
    expect(counts.rows.every((row) => row.token_count > 0)).toBe(true);

    const persisted = await readCorpusStats(pgPool);
    expect(persisted.totalDocs).toBe(3);
    expect(persisted.totalTokens).toBe(
      [...index.docLengths.values()].reduce((sum, n) => sum + n, 0),
    );
    expect(ids).toHaveLength(3);
  });
});
