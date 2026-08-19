import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SUGGESTION_LIMIT } from "shared";
import { closePg, pgPool } from "../db/pg.js";
import type { Queryable } from "../ranking/searchStore.js";
import { SuggestIndex } from "./autocomplete.js";

// Most of this suite needs no infrastructure at all — the payoff for `SuggestIndex` taking a
// `Queryable` rather than importing `db/pg.js`, the same split that let 44 of 2.4's 54 tests
// run without a server. The prefix arithmetic, the ranking order and the whole staleness
// policy are exercised against a fake client and an injected clock. The last describe block
// runs against the real migrated DB, because what is worth catching there is the SQL.

/** A `Queryable` that answers the two statements `SuggestIndex` issues, and counts them. */
class FakeDb implements Queryable {
  terms: { surface_form: string | null; doc_freq: number }[] = [];
  updatedAt = 1_000;
  termQueries = 0;
  statsQueries = 0;
  failWith: Error | null = null;
  /** Resolved by the test to release an in-flight `SELECT ... FROM terms`. */
  gate: (() => void) | null = null;

  async query<R extends Record<string, unknown>>(sql: string): Promise<{ rows: R[]; rowCount: number | null }> {
    if (this.failWith !== null) throw this.failWith;

    if (sql.includes("corpus_stats")) {
      this.statsQueries++;
      const row = {
        total_docs: 1,
        total_tokens: "10",
        avg_doc_len: 10,
        updated_at: new Date(this.updatedAt),
      };
      return { rows: [row] as unknown as R[], rowCount: 1 };
    }

    if (sql.includes("FROM terms")) {
      this.termQueries++;
      if (this.gate !== null) {
        await new Promise<void>((resolve) => {
          this.gate = resolve;
        });
      }
      //The real query filters NULLs in SQL; the fake honours the same contract so the tests
      //above it are not quietly relying on a filter that only exists in one of the two.
      const rows = this.terms.filter((t) => t.surface_form !== null);
      return { rows: rows as unknown as R[], rowCount: rows.length };
    }

    throw new Error(`unexpected query: ${sql}`);
  }
}

function fakeDbWith(terms: Record<string, number>): FakeDb {
  const db = new FakeDb();
  db.terms = Object.entries(terms).map(([surface_form, doc_freq]) => ({ surface_form, doc_freq }));
  return db;
}

/** Let the microtask queue drain until `predicate` holds, so a test can wait on internal progress. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

/** A `SuggestIndex` over a fake corpus with a manually advanced clock. */
function indexWith(terms: Record<string, number>, minPollIntervalMs = 30_000) {
  const db = fakeDbWith(terms);
  let clock = 0;
  const index = new SuggestIndex(db, { minPollIntervalMs, now: () => clock });
  return { db, index, advance: (ms: number) => (clock += ms) };
}

describe("suggest — matching", () => {
  it("returns the surface forms that start with the typed prefix", async () => {
    const { index } = indexWith({ crawler: 5, crawling: 3, indexing: 4 });

    expect(await index.suggest("craw")).toEqual([
      { term: "crawler", weight: 5 },
      { term: "crawling", weight: 3 },
    ]);
  });

  it("returns nothing for a prefix no term starts with", async () => {
    const { index } = indexWith({ crawler: 5 });
    expect(await index.suggest("zzz")).toEqual([]);
  });

  it("finds matches at both ends of the sorted array", async () => {
    const { index } = indexWith({ alpha: 1, middle: 1, zulu: 1 });

    expect(await index.suggest("al")).toEqual([{ term: "alpha", weight: 1 }]);
    expect(await index.suggest("zu")).toEqual([{ term: "zulu", weight: 1 }]);
  });

  it("finds matches regardless of the order rows arrive in", async () => {
    //There is no ORDER BY on the terms query: Postgres's collation can disagree with JS
    //code-unit order, and the binary search is only valid against the JS one. So the sort
    //happens in the module, and rows may arrive however the planner felt like returning them.
    const { index } = indexWith({ crawling: 3, alpha: 1, crawler: 5, zulu: 1 });

    expect(await index.suggest("craw")).toEqual([
      { term: "crawler", weight: 5 },
      { term: "crawling", weight: 3 },
    ]);
  });

  it("matches a whole term that is also a prefix of longer ones", async () => {
    const { index } = indexWith({ index: 9, indexer: 4, indexing: 2 });

    expect((await index.suggest("index")).map((s) => s.term)).toEqual(["index", "indexer", "indexing"]);
  });
});

describe("suggest — the typed prefix is normalized, not processed", () => {
  it("lowercases and strips diacritics, matching how surface forms were produced", async () => {
    const { index } = indexWith({ cafe: 2 });

    //`normalizeToken` is the same function 2.1 ran to produce `surface_form`, which is what
    //makes the typed text comparable to the stored spelling at all.
    expect(await index.suggest("CAFÉ")).toEqual([{ term: "cafe", weight: 2 }]);
  });

  it("suggests through a stopword prefix, which processQuery would have dropped", async () => {
    //The load-bearing half of decision 3. `processQuery` drops stopwords, so a user typing
    //`th` on the way to `throughput` would get nothing — and it would look like an empty
    //corpus rather than a bug, because the failure is an empty list either way.
    const { index } = indexWith({ throughput: 6, the: 40 });

    expect((await index.suggest("th")).map((s) => s.term)).toEqual(["the", "throughput"]);
  });

  it("does not stem the prefix", async () => {
    //The other half: `processQuery("crawling")` stems to `crawl`, which is not a prefix of
    //anything a user would want back, and `crawling` itself would stop matching itself.
    const { index } = indexWith({ crawling: 3 });

    expect(await index.suggest("crawling")).toEqual([{ term: "crawling", weight: 3 }]);
  });

  it("returns nothing when the fragment normalizes away entirely", async () => {
    const { index } = indexWith({ crawler: 5 });
    expect(await index.suggest("!!!")).toEqual([]);
  });

  it("returns nothing for empty input", async () => {
    const { index } = indexWith({ crawler: 5 });
    expect(await index.suggest("")).toEqual([]);
  });
});

describe("suggest — multi-word input", () => {
  it("completes the last token and carries the typed head through verbatim", async () => {
    const { index } = indexWith({ crawler: 5 });

    expect(await index.suggest("web cr")).toEqual([{ term: "web crawler", weight: 5 }]);
  });

  it("preserves the head's own spacing and casing", async () => {
    //The head is echoed, not reprocessed — the client is completing what the user typed, and
    //rewriting the part they already finished is how an autocomplete fights its user.
    const { index } = indexWith({ crawler: 5 });

    expect(await index.suggest("The  Web  cr")).toEqual([{ term: "The  Web  crawler", weight: 5 }]);
  });

  it("returns nothing when the input ends in whitespace", async () => {
    //Nothing is being typed yet, so there is no fragment to complete.
    const { index } = indexWith({ crawler: 5 });
    expect(await index.suggest("web ")).toEqual([]);
  });
});

describe("suggest — ranking", () => {
  it("orders by doc_freq, highest first", async () => {
    const { index } = indexWith({ ranking: 2, rank: 9, ranked: 5 });

    expect((await index.suggest("rank")).map((s) => s.term)).toEqual(["rank", "ranked", "ranking"]);
  });

  it("breaks doc_freq ties by shortest, then lexicographically", async () => {
    //Ties are the common case on a small corpus. Without a deterministic secondary sort the
    //answer is a function of row order rather than of the corpus, so two users see different
    //suggestions over identical data — the rule 2.2 set for `pickSurfaceForm` and 2.4 for
    //`docId` ties. Shortest-first is also the better answer for a person.
    const { index } = indexWith({ cardiovascular: 4, car: 4, cargo: 4, card: 4 });

    expect((await index.suggest("car")).map((s) => s.term)).toEqual([
      "car",
      "card",
      "cargo",
      "cardiovascular",
    ]);
  });

  it("defaults to SUGGESTION_LIMIT results", async () => {
    const terms = Object.fromEntries(
      Array.from({ length: SUGGESTION_LIMIT + 5 }, (_, i) => [`term${i}`, i]),
    );
    const { index } = indexWith(terms);

    expect(await index.suggest("term")).toHaveLength(SUGGESTION_LIMIT);
  });

  it("honours an explicit limit", async () => {
    const { index } = indexWith({ crawler: 5, crawling: 3, crawled: 1 });

    expect((await index.suggest("craw", { limit: 2 })).map((s) => s.term)).toEqual([
      "crawler",
      "crawling",
    ]);
  });

  it("returns nothing for a non-positive limit", async () => {
    const { index } = indexWith({ crawler: 5 });
    expect(await index.suggest("craw", { limit: 0 })).toEqual([]);
  });

  it("keeps the highest-weighted matches, not the first ones found", async () => {
    //The array is sorted by surface, so the top-weighted term can sit anywhere in the prefix
    //range. Taking the first `limit` off the front would return alphabetical order wearing a
    //ranking's clothes — this is what makes the full-range scan necessary.
    const { index } = indexWith({ crawla: 1, crawlb: 2, crawlc: 99 });

    expect(await index.suggest("crawl", { limit: 1 })).toEqual([{ term: "crawlc", weight: 99 }]);
  });
});

describe("staleness — polling corpus_stats.updated_at", () => {
  it("builds on first use rather than in the constructor", async () => {
    const { db, index } = indexWith({ crawler: 5 });

    expect(db.termQueries).toBe(0);
    expect(index.size).toBe(0);

    await index.suggest("craw");
    expect(db.termQueries).toBe(1);
    expect(index.size).toBe(1);
  });

  it("does not re-check the version inside the poll interval", async () => {
    const { db, index, advance } = indexWith({ crawler: 5 }, 30_000);

    await index.suggest("craw");
    const statsAfterBuild = db.statsQueries;

    advance(29_999);
    await index.suggest("craw");
    await index.suggest("crawl");

    expect(db.statsQueries).toBe(statsAfterBuild);
    expect(db.termQueries).toBe(1);
  });

  it("re-checks after the interval but does not rebuild when the version is unchanged", async () => {
    const { db, index, advance } = indexWith({ crawler: 5 }, 30_000);

    await index.suggest("craw");
    const statsAfterBuild = db.statsQueries;

    advance(30_000);
    await index.suggest("craw");

    expect(db.statsQueries).toBe(statsAfterBuild + 1);
    //The check is cheap; the rebuild is the part worth avoiding.
    expect(db.termQueries).toBe(1);
  });

  it("rebuilds when updated_at moves", async () => {
    const { db, index, advance } = indexWith({ crawler: 5 }, 30_000);

    await index.suggest("craw");
    expect(index.version).toBe(1_000);

    db.terms = [{ surface_form: "crawler", doc_freq: 5 }, { surface_form: "crawling", doc_freq: 7 }];
    db.updatedAt = 2_000;
    advance(30_000);

    expect((await index.suggest("craw")).map((s) => s.term)).toEqual(["crawling", "crawler"]);
    expect(db.termQueries).toBe(2);
    expect(index.version).toBe(2_000);
  });

  it("refresh() rebuilds regardless of interval or version", async () => {
    const { db, index } = indexWith({ crawler: 5 }, 30_000);

    await index.suggest("craw");
    db.terms = [{ surface_form: "crawler", doc_freq: 5 }, { surface_form: "crawled", doc_freq: 1 }];

    await index.refresh();

    expect(db.termQueries).toBe(2);
    expect(index.size).toBe(2);
  });

  it("treats an empty corpus as built, not as never-built", async () => {
    //"Built and empty" is a real answer. Conflating it with `null` would re-query `terms` on
    //every keystroke forever against a corpus that has simply not been indexed yet.
    const { db, index, advance } = indexWith({});

    expect(await index.suggest("craw")).toEqual([]);
    expect(db.termQueries).toBe(1);

    advance(1_000);
    expect(await index.suggest("craw")).toEqual([]);
    expect(db.termQueries).toBe(1);
  });
});

describe("staleness — failure handling", () => {
  it("serves the existing array when a later poll fails", async () => {
    //Same call 1.2 made for a dead Redis: degrade to staler data rather than fail the request.
    //An autocomplete that 500s while someone is typing is worse than one a reindex behind.
    const { db, index, advance } = indexWith({ crawler: 5 }, 30_000);

    await index.suggest("craw");
    db.failWith = new Error("connection terminated");
    advance(30_000);

    expect(await index.suggest("craw")).toEqual([{ term: "crawler", weight: 5 }]);
  });

  it("propagates the error when nothing has been built yet", async () => {
    //With no array there is no degraded mode to fall back to, and silently returning `[]`
    //would render as "no such term" — a wrong answer where an error is the honest one.
    const { db, index } = indexWith({ crawler: 5 });
    db.failWith = new Error("connection terminated");

    await expect(index.suggest("craw")).rejects.toThrow("connection terminated");
  });

  it("recovers on the next poll after a failure clears", async () => {
    const { db, index, advance } = indexWith({ crawler: 5 }, 30_000);

    await index.suggest("craw");
    db.failWith = new Error("connection terminated");
    advance(30_000);
    await index.suggest("craw");

    db.failWith = null;
    db.terms = [{ surface_form: "crawler", doc_freq: 5 }, { surface_form: "crawling", doc_freq: 9 }];
    db.updatedAt = 2_000;
    advance(30_000);

    expect((await index.suggest("craw")).map((s) => s.term)).toEqual(["crawling", "crawler"]);
  });
});

describe("staleness — concurrency", () => {
  it("answers from the current array while a rebuild is in flight", async () => {
    const { db, index, advance } = indexWith({ crawler: 5 }, 30_000);
    await index.suggest("craw");

    //Hold the next terms query open, then trigger a rebuild by moving the version.
    db.gate = () => {};
    db.updatedAt = 2_000;
    db.terms = [{ surface_form: "crawling", doc_freq: 9 }];
    advance(30_000);
    const rebuilding = index.suggest("craw");
    //Wait until that call has actually reached the terms query, so the rebuild is registered.
    //Without this the second `suggest` races it, passes the version check on its own, and
    //correctly dedupes onto the same in-flight rebuild — which is right, but is a different
    //behaviour from the one under test here, and it deadlocks against the gate.
    await until(() => db.termQueries === 2);

    //A keystroke arriving mid-rebuild is served the old array rather than made to wait. The
    //clock moves again so the poll interval cannot be what short-circuits this — the in-flight
    //guard has to be the thing doing the work, or the test proves nothing.
    advance(30_000);
    expect(await index.suggest("craw")).toEqual([{ term: "crawler", weight: 5 }]);
    expect(db.termQueries).toBe(2);

    db.gate!();
    await rebuilding;
    expect((await index.suggest("craw")).map((s) => s.term)).toEqual(["crawling"]);
  });

  it("does not start a second rebuild while one is running", async () => {
    const { db, index } = indexWith({ crawler: 5 });

    db.gate = () => {};
    const first = index.refresh();
    const second = index.refresh();

    //Wait until the rebuild has actually reached the terms query before releasing the gate.
    //`refresh()` reads the corpus version *first* (see `#rebuild` — a version read after its
    //rows can stamp stale data as fresh), so the terms query is no longer the first thing this
    //call does, and releasing the gate synchronously would fire it before the query is holding
    //it. The dedup under test is unaffected: both `refresh()` calls are still issued back to
    //back, and `#rebuilding` is set synchronously by the first.
    await until(() => db.termQueries === 1);
    db.gate!();
    await Promise.all([first, second]);

    expect(db.termQueries).toBe(1);
  });
});

describe("against the real database", () => {
  afterAll(closePg);

  beforeEach(async () => {
    await pgPool.query("TRUNCATE terms, postings RESTART IDENTITY CASCADE");
    await pgPool.query("DELETE FROM corpus_stats");
  });

  async function setUpdatedAt(iso: string): Promise<void> {
    await pgPool.query(
      `INSERT INTO corpus_stats (id, total_docs, total_tokens, avg_doc_len, updated_at)
       VALUES (1, 1, 10, 10, $1)
       ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
      [iso],
    );
  }

  it("skips terms with no surface form instead of falling back to the stem", async () => {
    //0.4 originally specified `COALESCE(surface_form, term)`. That surfaces a bare stem to a
    //human — `comput` — which is the exact breakage the column was added to prevent, so the
    //row is dropped instead. 2.3 always populates it, so this discards rows that should not
    //exist in the first place.
    await pgPool.query(
      `INSERT INTO terms (term, doc_freq, surface_form) VALUES ('comput', 3, NULL), ('crawl', 2, 'crawler')`,
    );
    await setUpdatedAt("2026-01-01T00:00:00Z");

    const index = new SuggestIndex(pgPool);

    expect(await index.suggest("comp")).toEqual([]);
    expect(await index.suggest("craw")).toEqual([{ term: "crawler", weight: 2 }]);
  });

  it("reads updated_at as epoch milliseconds and notices a real bump", async () => {
    //The round trip that matters: node-postgres hands back a `Date`, and comparing `Date`
    //objects with `!==` is always true because it compares identity rather than the instant.
    //A poll built that way rebuilds on every tick while looking perfectly correct in review.
    await pgPool.query(`INSERT INTO terms (term, doc_freq, surface_form) VALUES ('crawl', 2, 'crawler')`);
    await setUpdatedAt("2026-01-01T00:00:00Z");

    let clock = 0;
    const index = new SuggestIndex(pgPool, { minPollIntervalMs: 1_000, now: () => clock });

    await index.suggest("craw");
    expect(index.version).toBe(Date.UTC(2026, 0, 1));

    //Same instant, re-written: the version must not move, or every poll is a rebuild.
    await setUpdatedAt("2026-01-01T00:00:00Z");
    clock += 1_000;
    await index.suggest("craw");
    expect(index.size).toBe(1);
    expect(index.version).toBe(Date.UTC(2026, 0, 1));

    await pgPool.query(`INSERT INTO terms (term, doc_freq, surface_form) VALUES ('index', 5, 'indexing')`);
    await setUpdatedAt("2026-01-02T00:00:00Z");
    clock += 1_000;

    expect(await index.suggest("ind")).toEqual([{ term: "indexing", weight: 5 }]);
    expect(index.version).toBe(Date.UTC(2026, 0, 2));
  });
});
