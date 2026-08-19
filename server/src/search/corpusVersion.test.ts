import { describe, expect, it } from "vitest";
import type { Queryable } from "../ranking/searchStore.js";
import { CorpusVersion } from "./corpusVersion.js";

// No infrastructure at all: the throttle, the degrade rule and the in-flight dedup are the whole
// of this class, and all three are decisions about *when* to issue a query rather than about the
// query itself. The one statement it runs is already covered against the real database by
// `indexStore.test.ts`'s `updated_at` round trip.

/** A `Queryable` answering the single `corpus_stats` read, counting it, and able to fail or stall. */
class FakeDb implements Queryable {
  updatedAt = 1_000;
  statsQueries = 0;
  failWith: Error | null = null;
  /** Resolved by the test to release an in-flight read. */
  gate: (() => void) | null = null;

  async query<R extends Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    if (!sql.includes("corpus_stats")) throw new Error("unexpected query");
    this.statsQueries++;

    if (this.gate !== null) {
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    if (this.failWith !== null) throw this.failWith;

    const row = {
      total_docs: 1,
      total_tokens: "10",
      avg_doc_len: 10,
      updated_at: new Date(this.updatedAt),
    };
    return { rows: [row] as unknown as R[], rowCount: 1 };
  }
}

/** A watcher over a fake corpus with a manually advanced clock. */
function watcherWith(minPollIntervalMs = 30_000) {
  const db = new FakeDb();
  let clock = 0;
  const version = new CorpusVersion(db, { minPollIntervalMs, now: () => clock });
  return { db, version, advance: (ms: number) => (clock += ms) };
}

/** Let the microtask queue drain until `predicate` holds, so a test can wait on internal progress. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition never became true");
}

describe("reading the version", () => {
  it("reads nothing until asked", () => {
    const { db, version } = watcherWith();

    expect(db.statsQueries).toBe(0);
    expect(version.last).toBeNull();
  });

  it("returns updated_at as epoch milliseconds", async () => {
    //Not a `Date`. `new Date(x) !== new Date(x)` is always true — object identity, not value —
    //so a consumer comparing `Date`s detects a reindex on every tick and rebuilds forever.
    const { version } = watcherWith();

    const current = await version.current();

    expect(current).toBe(1_000);
    expect(typeof current).toBe("number");
  });

  it("reports a version that has moved", async () => {
    const { db, version, advance } = watcherWith(30_000);
    await version.current();

    db.updatedAt = 2_000;
    advance(30_000);

    expect(await version.current()).toBe(2_000);
  });

  it("treats an unindexed corpus as a real answer, not as never-read", async () => {
    //`readCorpusStats` returns zeros when the row is missing, so `0` is a version. Conflating it
    //with "never read" would make a failure on an unindexed corpus propagate rather than degrade.
    const { db, version } = watcherWith();
    db.updatedAt = 0;

    expect(await version.current()).toBe(0);
    expect(version.last).toBe(0);
  });
});

describe("the poll interval", () => {
  it("does not re-read inside the interval", async () => {
    const { db, version, advance } = watcherWith(30_000);
    await version.current();

    advance(29_999);
    await version.current();
    await version.current();

    expect(db.statsQueries).toBe(1);
  });

  it("re-reads once the interval has passed", async () => {
    const { db, version, advance } = watcherWith(30_000);
    await version.current();

    advance(30_000);
    await version.current();

    expect(db.statsQueries).toBe(2);
  });

  it("serves a stale version from inside the interval even after it has moved", async () => {
    //The throttle is the whole point: the cost of being one interval late is bounded and known,
    //and paying a query per request to avoid it is the trade this class exists to refuse.
    const { db, version, advance } = watcherWith(30_000);
    await version.current();

    db.updatedAt = 2_000;
    advance(29_999);

    expect(await version.current()).toBe(1_000);
    expect(db.statsQueries).toBe(1);
  });

  it("does not throttle before the first successful read", async () => {
    //Never-read has nothing to serve in the meantime, so a consumer starting up must not be
    //told to wait an interval for its first answer.
    const { db, version } = watcherWith(30_000);
    db.failWith = new Error("connection terminated");

    await expect(version.current()).rejects.toThrow("connection terminated");
    await expect(version.current()).rejects.toThrow("connection terminated");

    expect(db.statsQueries).toBe(2);
  });
});

describe("failure handling", () => {
  it("returns the last known version when a read fails", async () => {
    //1.2's call for a dead Redis, restated over the read: degrade rather than stop. A consumer
    //that sees an unchanged version keeps serving what it built, which is the desired outcome.
    const { db, version, advance } = watcherWith(30_000);
    await version.current();

    db.failWith = new Error("connection terminated");
    advance(30_000);

    expect(await version.current()).toBe(1_000);
  });

  it("propagates when no read has ever succeeded", async () => {
    //There is no degraded mode to offer. Returning a made-up `0` would announce a reindex that
    //did not happen; returning the caller's own version would claim a freshness this class
    //cannot vouch for.
    const { db, version } = watcherWith();
    db.failWith = new Error("connection terminated");

    await expect(version.current()).rejects.toThrow("connection terminated");
    expect(version.last).toBeNull();
  });

  it("still consumes the interval when a read fails", async () => {
    //Stamped before the attempt, so a database that is down is polled once per interval rather
    //than on every request that arrives while it is down.
    const { db, version, advance } = watcherWith(30_000);
    await version.current();

    db.failWith = new Error("connection terminated");
    advance(30_000);
    await version.current();
    const afterFailedPoll = db.statsQueries;

    advance(29_999);
    await version.current();

    expect(db.statsQueries).toBe(afterFailedPoll);
  });

  it("recovers on the next poll after the failure clears", async () => {
    const { db, version, advance } = watcherWith(30_000);
    await version.current();

    db.failWith = new Error("connection terminated");
    advance(30_000);
    await version.current();

    db.failWith = null;
    db.updatedAt = 2_000;
    advance(30_000);

    expect(await version.current()).toBe(2_000);
  });
});

describe("concurrency", () => {
  it("issues one read for callers arriving together", async () => {
    const { db, version } = watcherWith();

    db.gate = () => {};
    const first = version.current();
    await until(() => db.statsQueries === 1);
    const second = version.current();

    db.gate!();

    expect(await first).toBe(1_000);
    expect(await second).toBe(1_000);
    expect(db.statsQueries).toBe(1);
  });

  it("degrades every caller joined to a read that fails", async () => {
    //The dedup must not route the second caller around the degrade rule — both are answered by
    //the same rejected promise, and both have to come back with the last known version.
    const { db, version, advance } = watcherWith(30_000);
    await version.current();

    db.failWith = new Error("connection terminated");
    db.gate = () => {};
    advance(30_000);
    const first = version.current();
    await until(() => db.statsQueries === 2);
    const second = version.current();

    db.gate!();

    expect(await first).toBe(1_000);
    expect(await second).toBe(1_000);
  });
});
