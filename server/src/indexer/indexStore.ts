//Phase 2.3 — the only module in Phase 2 that touches Postgres. 2.1 and 2.2 are pure
//functions over strings and iterables; this is where the value `buildIndex` computes turns
//into rows, and where the corpus turns back into the stream that feeds it.
//
//It takes its client as an argument rather than importing `db/pg.js`, the same rule
//`DocumentStore` follows for its `Queryable` and `crawl()` for its `Frontier` — `cli.ts` is
//the single place that opens and closes a connection. The type-only `pg` import is what
//keeps that true: `PoolClient` is erased at compile time, so nothing here reaches config.

//Node's built-in readable stream class — used later to turn the plain JS generator (rows() in copyPostings) into a stream object that pipeline can consume.
import { Readable } from "node:stream";
//A promise-based helper that connects a readable stream to a writable stream and awaits until the data has fully flowed through 
// — handles backpressure and cleans up both ends properly if either side errors.
import { pipeline } from "node:stream/promises";
import type { PoolClient } from "pg";
//Imports the from function from the pg-copy-streams library (renamed to copyFrom to avoid clashing with the JS keyword from) 
//  — wraps SQL command into a writable stream that Postgres will bulk-load data through.
import { from as copyFrom } from "pg-copy-streams";
import type { CorpusSource } from "shared";
import type { BuiltIndex, CorpusStats, IndexableDocument } from "./invertedIndex.js";

export const INDEX_STORE_DEFAULTS = {
 //how many documents to pull from Postgres at a time when streaming the corpus in for indexing.
  readBatchSize: 500,
 //how many rows go into a single unnest-based INSERT/UPDATE when writing terms or token counts back out.
  writeBatchSize: 5_000,
} as const;

//describes the minimum shape of "something I can run a SQL query against" — just a .query(sql, params) method that returns rows.
export interface DocumentSource {
  query<R extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

//IndexWriteStats — what writeIndex reports back when it's done (how many terms, postings, documents were written, plus the corpus totals). 
// Useful for a CLI to print "Indexed 12,000 documents, 340,000 postings" at the end of a run.
export interface IndexWriteStats {
  terms: number;
  postings: number;
  /** Documents whose `token_count` was written back. */
  documents: number;
  totalTokens: number;
  avgDocLen: number;
}

export interface StreamDocumentsOptions {
  batchSize?: number;
}

export interface WriteIndexOptions {
  batchSize?: number;
}
//DocumentRow — the raw shape of a row as Postgres returns it
interface DocumentRow extends Record<string, unknown> {
  id: number;
  title: string;
  content_text: string;
}

/**
 * Stream every document in the corpus, oldest id first.
 *
 * Keyset pagination rather than a `pg` cursor. A cursor would need its own dedicated client
 * checked out for the whole build and leaks a connection if it is not closed on the error
 * path; `documents.id` is a serial primary key, so `WHERE id > $1 ORDER BY id` walks it with
 * an index seek per batch and no lifecycle to get wrong. It also reads on its own connection,
 * outside the write transaction — which is what we want, since that transaction is holding
 * delete locks on `terms` and `postings`.
 *
 * The reason to stream at all is that `content_text` across a corpus is far larger than the
 * index derived from it: 2.2 accepts holding the finished index in memory, not every page's
 * prose at once.
 */

//Why it exists: buildIndex (2.2) needs to see every document to build the index, but a corpus's raw text is much bigger than the index derived from it
//  — lots of prose collapses into a comparatively small set of (term → posting list) entries. So this file streams documents in one at a time (or in small batches under the hood) 
// rather than loading them all into an array first.
export async function* streamDocuments(
  db: DocumentSource,
  options: StreamDocumentsOptions = {},
): AsyncGenerator<IndexableDocument> {
  const batchSize = options.batchSize ?? INDEX_STORE_DEFAULTS.readBatchSize;
  let after = 0;

  for (;;) {
    const { rows } = await db.query<DocumentRow>(
      `SELECT id, title, content_text
         FROM documents
        WHERE id > $1
        ORDER BY id
        LIMIT $2`,
      [after, batchSize],
    );

    const last = rows[rows.length - 1];
    if (last === undefined) return;

    for (const row of rows) {
      yield { id: row.id, title: row.title, contentText: row.content_text };
    }

    after = last.id;
  }
}

/**
 * Write a `BuiltIndex` to Postgres, replacing whatever was there, in one transaction.
 *
 * **A full rebuild, not an upsert.** `doc_freq` is a corpus-global count — you cannot know
 * how many documents contain a stem until every document has been seen — which is exactly
 * why 2.2 refused to flush in batches. Merging a `BuiltIndex` into existing rows would be
 * that same rejected thing moved down to the SQL layer: every term absent from the new build
 * would keep a stale `doc_freq` and go on poisoning IDF for a term that no longer exists.
 * Nothing depends on `terms.id` surviving a rebuild — `postings.term_id` is the only
 * reference to it, and it is rewritten here in the same transaction.
 *
 * **`DELETE`, not `TRUNCATE`, and the difference is not cosmetic.** Per the hosting model
 * this job runs on a dev machine against the same Postgres the deployed API reads.
 * `TRUNCATE` takes an ACCESS EXCLUSIVE lock, so every concurrent `/search` would block for
 * the whole rebuild; `DELETE` takes ROW EXCLUSIVE and MVCC keeps readers serving the *old*
 * index from their snapshot until this transaction commits. Same atomicity, no stall. The
 * cost is dead tuples for autovacuum to reclaim, which is noise at this corpus size — and
 * if it ever stops being noise, the escape hatch is to load into `terms_new`/`postings_new`
 * and `ALTER TABLE ... RENAME`, which does not change anything above this function.
 */

//What it does: takes a fully-built BuiltIndex (the in-memory result of 2.2) and writes it to Postgres — wiping the old terms/postings tables and replacing them,
//  updating each document's token_count, and updating the corpus-wide stats — all inside one transaction.
export async function writeIndex(
  client: PoolClient,
  index: BuiltIndex,
  options: WriteIndexOptions = {},
): Promise<IndexWriteStats> {
  const batchSize = options.batchSize ?? INDEX_STORE_DEFAULTS.writeBatchSize;

  //BEGIN opens an explicit transaction — everything from here to COMMIT either all happens or none of it does.
  await client.query("BEGIN");

  try {
    //Postings first. `postings.term_id` is ON DELETE CASCADE, so deleting terms alone would
    //work — by firing a per-row cascade trigger for every term, to do a job one unqualified
    //DELETE does in a single pass.
    await client.query("DELETE FROM postings");
    await client.query("DELETE FROM terms");

    const termIds = await insertTerms(client, index, batchSize);
    const postings = await copyPostings(client, index, termIds);
    const documents = await writeTokenCounts(client, index, batchSize);

    //writeCorpusStats — updates the single-row corpus_stats table (BM25's global N and avgdl).
    await writeCorpusStats(client, index.stats);

    //COMMIT — makes it all visible atomically.
    await client.query("COMMIT");

    return {
      terms: termIds.size,
      postings,
      documents,
      totalTokens: index.stats.totalTokens,
      avgDocLen: index.stats.avgDocLen,
    };
  } catch (error) {
    //Rolling back can itself fail if the connection died mid-write. Swallowing that would
    //replace the real error with a less useful one, so the original propagates.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

/**
 * The `corpus_stats` row as stored — the computed statistics plus the reindex signal.
 *
 * `updatedAt` is deliberately *not* a field on `CorpusStats` itself. That type is what
 * `buildIndex` computes in memory, where no such timestamp exists, and what the pure scorer
 * takes; putting a persistence fact on it would force `buildIndex` to invent a value and make
 * every ranking fixture carry a number it never reads.
 */
export interface PersistedCorpusStats extends CorpusStats {
  /**
   * `corpus_stats.updated_at` as **epoch milliseconds** — Phase 3's reindex signal, written by
   * `writeCorpusStats` on every index run and polled by 3.3/3.4 to notice that the index job
   * (which runs in another process entirely) has rebuilt underneath them.
   *
   * A number rather than the `Date` node-postgres hands back, and that is not a style
   * preference. `new Date(x) !== new Date(x)` is *always* true — it compares object identity,
   * not the instant — so a poll holding the previous `Date` and comparing it against a fresh
   * one detects a reindex on every single tick, rebuilding its state forever while reviewing
   * as obviously correct. Converted here, in the one place, exactly like the BIGINT below.
   */
  updatedAt: number;
}

//What it does: reads the single row out of corpus_stats and returns it as a properly-typed object.
export async function readCorpusStats(db: DocumentSource): Promise<PersistedCorpusStats> {
  const { rows } = await db.query<{
    total_docs: number;
    total_tokens: string;
    avg_doc_len: number;
    updated_at: Date;
  }>("SELECT total_docs, total_tokens, avg_doc_len, updated_at FROM corpus_stats WHERE id = 1");

  const row = rows[0];
  if (row === undefined) return { totalDocs: 0, totalTokens: 0, avgDocLen: 0, updatedAt: 0 };

  return {
    totalDocs: row.total_docs,
    //`total_tokens` is BIGINT, and node-postgres returns BIGINT as a *string* rather than
    //risk silent precision loss past 2^53. `CorpusStats.totalTokens` is a JS number, so the
    //conversion has to happen somewhere; here is the one place, because a `Number(...)`
    //sprinkled at each call site is a `NaN` waiting for the one site that forgets.
    totalTokens: Number(row.total_tokens),
    avgDocLen: row.avg_doc_len,
    updatedAt: row.updated_at.getTime(),
  };
}

/** How many sites to name. Enough to describe a corpus, few enough to read in one line. */
export const CORPUS_SOURCE_LIMIT = 5;

/**
 * Which sites the corpus is made of, largest first.
 *
 * Exists because "1,437 documents indexed" tells a first-time visitor nothing they can act
 * on — a search box over an unnamed corpus is a prompt with no context, and they will type
 * something generic, get nothing, and conclude it is broken. Naming the hosts is the
 * cheapest thing that turns the number into an invitation.
 *
 * Derived from `documents.url` rather than configured, so it cannot drift from what was
 * actually crawled. `split_part(url, '/', 3)` is the host because every stored URL has been
 * through `normalizeUrl` and therefore always has a scheme — 1.3 guarantees the shape this
 * relies on.
 *
 * A sequential scan with a grouping, deliberately unindexed: it runs once per empty-state
 * render on a table that also holds `content_text`, which is the expensive part, and at
 * corpus sizes this project targets it is single-digit milliseconds. If it ever stops being
 * noise the answer is a materialized count refreshed by `writeIndex`, not an index on an
 * expression.
 */
export async function readCorpusSources(db: DocumentSource): Promise<CorpusSource[]> {
  const { rows } = await db.query<{ host: string; documents: string }>(
    `SELECT split_part(url, '/', 3) AS host, count(*) AS documents
       FROM documents
      GROUP BY 1
      ORDER BY count(*) DESC, host ASC
      LIMIT $1`,
    [CORPUS_SOURCE_LIMIT],
  );

  //`count(*)` is BIGINT, which node-postgres returns as a string — the same trap
  //`total_tokens` documents above, converted in the one place that reads it.
  return rows.map((row) => ({ host: row.host, documents: Number(row.documents) }));
}

//What it does: inserts every term from the built index into the terms table, and returns a map from term string 
// → the numeric id Postgres assigned it (needed because postings.term_id is a foreign key to that id, not the term text itself).

/*
Concrete example: say index.terms has an entry for the stem "crawl" with surfaceForm: "crawling" and 3 postings (it appears in 3 documents). 
After insertTerms runs, ids.get("crawl") might return 147 — Postgres's auto-assigned id for that row — and that 147 is what copyPostings needs to correctly link every "crawl" posting back to its term row.
*/
async function insertTerms(
  client: PoolClient,
  index: BuiltIndex,
  batchSize: number,
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();

  let terms: string[] = [];
  let docFreqs: number[] = [];
  let surfaces: string[] = [];

  const flush = async (): Promise<void> => {
    if (terms.length === 0) return;

    const { rows } = await client.query<{ id: number; term: string }>(
      `INSERT INTO terms (term, doc_freq, surface_form)
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[])
       RETURNING id, term`,
      [terms, docFreqs, surfaces],
    );

    for (const row of rows) ids.set(row.term, row.id);

    terms = [];
    docFreqs = [];
    surfaces = [];
  };

  for (const entry of index.terms.values()) {
    terms.push(entry.term);
    //2.2's decision, carried through: `doc_freq` is the posting list's length and is never
    //tracked as a second field. One posting per (term, document) is what makes that a valid
    //document frequency, and `buildIndex`'s duplicate-id guard is what makes *that* true.
    docFreqs.push(entry.postings.length);
    surfaces.push(entry.surfaceForm);

    if (terms.length >= batchSize) await flush();
  }

  await flush();

  return ids;
}

//What it does: bulk-loads every posting (each (term, document, term-frequency, positions) tuple) into the postings table, using COPY FROM STDIN 
// — Postgres's fastest bulk-load mechanism — rather than row-by-row inserts.
async function copyPostings(
  client: PoolClient,
  index: BuiltIndex,
  termIds: ReadonlyMap<string, number>,
): Promise<number> {
  let written = 0;

  function* rows(): Generator<string> {
    for (const entry of index.terms.values()) {
      const termId = termIds.get(entry.term);

      //Unreachable unless `insertTerms` silently dropped a row. Loud here beats a foreign
      //key violation several thousand rows later that names an integer and not a word.
      if (termId === undefined) {
        throw new Error(`writeIndex: no term id was returned for "${entry.term}"`);
      }

      for (const posting of entry.postings) {
        written += 1;
        //`{}` for an empty array — a document can contain a term at no positions only if
        //2.1 changes, but Postgres accepts it and a guard here would be dead code.
        yield `${termId}\t${posting.docId}\t${posting.tf}\t{${posting.positions.join(",")}}\n`;
      }
    }
  }

  const stream = client.query(
    copyFrom("COPY postings (term_id, doc_id, tf, positions) FROM STDIN"),
  );

  //pipeline(Readable.from(rows(), { objectMode: false }), stream) — connects the generator (as a readable stream) 
  // to the COPY writable stream, and drives data through it, from Node's stream/promises.
  await pipeline(Readable.from(rows(), { objectMode: false }), stream);

  return written;
}

//What it does: writes each document's indexed token length back into documents.token_count.
//Why it matters for BM25 specifically: BM25's ranking formula includes a length-normalization term that compares 
// a document's length to the corpus's average length (avgdl, from corpus_stats). If token_count weren't filled back in, every document would look zero-length to the ranker, wrecking every score.
async function writeTokenCounts(
  client: PoolClient,
  index: BuiltIndex,
  batchSize: number,
): Promise<number> {
  let updated = 0;

  let ids: number[] = [];
  let counts: number[] = [];

  const flush = async (): Promise<void> => {
    if (ids.length === 0) return;

    const { rowCount } = await client.query(
      `UPDATE documents d
          SET token_count = v.token_count
         FROM unnest($1::int[], $2::int[]) AS v(id, token_count)
        WHERE d.id = v.id`,
      [ids, counts],
    );

    updated += rowCount ?? 0;

    ids = [];
    counts = [];
  };

  for (const [docId, length] of index.docLengths) {
    ids.push(docId);
    counts.push(length);

    if (ids.length >= batchSize) await flush();
  }

  await flush();

  return updated;
}

//What it does: writes (or updates) the single row in corpus_stats — the corpus-wide N (total document count) and avgdl (average document length) that BM25's formula needs.
async function writeCorpusStats(client: PoolClient, stats: CorpusStats): Promise<void> {
  //An upsert rather than an UPDATE even though the migration seeds the row, because an
  //UPDATE against a missing row succeeds with rowCount 0 — a corpus_stats table that
  //silently stayed empty would give every BM25 score an `avgdl` of zero.
  await client.query(
    `INSERT INTO corpus_stats (id, total_docs, total_tokens, avg_doc_len, updated_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       total_docs   = EXCLUDED.total_docs,
       total_tokens = EXCLUDED.total_tokens,
       avg_doc_len  = EXCLUDED.avg_doc_len,
       updated_at   = EXCLUDED.updated_at`,
    //Sent as a string on the way in for the same reason it comes back as one: the column is
    //BIGINT, and letting the driver infer from a JS number is how a large corpus would start
    //rounding without saying so.
    [stats.totalDocs, String(stats.totalTokens), stats.avgDocLen],
  );
}
