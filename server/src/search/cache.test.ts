import { describe, expect, it } from "vitest";
import type { CorpusStats } from "../indexer/invertedIndex.js";
import type { SearchPage } from "./queryProcessor.js";
import { cacheKey, ResultCache, toCachedPage, type CachedPage } from "./cache.js";

// Every test here runs against no infrastructure, which is the point of the module taking its
// version as an argument rather than reading it: nothing in `ResultCache` touches Postgres, so
// there is nothing to stand up. The same split that let 30 of 3.3's 33 tests and 15 of 3.2's 17
// run against plain values.

const STATS: CorpusStats = { totalDocs: 4, totalTokens: 100, avgDocLen: 25 };

/** A cached page carrying roughly `chars` bytes of snippet, for the byte-bound tests. */
function pageOfSize(chars: number): CachedPage {
  return {
    ...pageWith(1),
    results: [
      {
        docId: 1,
        url: "https://example.com/a",
        title: "A",
        score: 1,
        matchedTerms: ["document"],
        snippet: "x".repeat(chars),
        matches: [],
      },
    ],
  };
}

/** A minimal cached page, distinguishable from another by `total`. */
function pageWith(total: number): CachedPage {
  return {
    status: "ok",
    stems: ["document"],
    page: 1,
    pageSize: 10,
    total,
    results: [],
    stats: STATS,
  };
}

describe("cacheKey", () => {
  it("is the same for queries that stem alike", () => {
    //The whole reason the key is the stems rather than the typed string: `Documents` and
    //`documents` are one question, and keying on what was typed makes them two entries.
    expect(cacheKey(["document"], 1, 10)).toBe(cacheKey(["document"], 1, 10));
  });

  it("separates pages and page sizes", () => {
    const first = cacheKey(["document"], 1, 10);

    expect(cacheKey(["document"], 2, 10)).not.toBe(first);
    expect(cacheKey(["document"], 1, 20)).not.toBe(first);
  });

  it("separates queries whose stems differ", () => {
    expect(cacheKey(["document"], 1, 10)).not.toBe(cacheKey(["crawler"], 1, 10));
  });

  it("does not merge a multi-stem query with a single stem containing a space", () => {
    //The reason the key is encoded rather than joined on a separator. This input cannot occur
    //today — 2.1's tokenizer splits on whitespace — but a key that is only unambiguous because
    //of that fails silently if it ever stops being true, by serving one query's results to
    //another. Caught by this test when the key was a space-joined string.
    expect(cacheKey(["web", "crawler"], 1, 10)).not.toBe(cacheKey(["web crawler"], 1, 10));
  });

  it("treats a reordered query as a different key", () => {
    //Sorting would win the hit, but `stems` is echoed inside the stored value, so the answer
    //would come back in the other order — the same defect excluding `query` exists to avoid.
    expect(cacheKey(["web", "crawler"], 1, 10)).not.toBe(cacheKey(["crawler", "web"], 1, 10));
  });
});

describe("toCachedPage", () => {
  it("drops query and terms and keeps everything else", () => {
    const page: SearchPage = {
      status: "ok",
      query: "Documents",
      stems: ["document"],
      page: 1,
      pageSize: 10,
      total: 3,
      results: [],
      terms: [{ term: "document", docFreq: 2, postings: [{ docId: 1, tf: 2, docLength: 40 }] }],
      stats: STATS,
    };

    const cached = toCachedPage(page);

    expect(cached).not.toHaveProperty("query");
    expect(cached).not.toHaveProperty("terms");
    expect(cached).toEqual({
      status: "ok",
      stems: ["document"],
      page: 1,
      pageSize: 10,
      total: 3,
      results: [],
      stats: STATS,
    });
  });

  it("keeps the status/stats pairing on the unsearchable branch", () => {
    //3.1 made these a discriminated union so `stats: null` cannot be read without checking the
    //status. A non-distributive `Omit` would collapse the two members and let `"ok"` pair with
    //`null` — this is the runtime half of that, the compiler holding the other.
    const page: SearchPage = {
      status: "no-searchable-terms",
      query: "the",
      stems: [],
      page: 1,
      pageSize: 10,
      total: 0,
      results: [],
      terms: [],
      stats: null,
    };

    const cached = toCachedPage(page);

    expect(cached.status).toBe("no-searchable-terms");
    expect(cached.stats).toBeNull();
  });
});

describe("get and set", () => {
  it("misses on an empty cache", () => {
    const cache = new ResultCache();

    expect(cache.get("a", 1_000)).toBeUndefined();
  });

  it("returns what was stored under the same key and version", () => {
    const cache = new ResultCache();
    cache.set("a", 1_000, pageWith(3));

    expect(cache.get("a", 1_000)?.total).toBe(3);
  });

  it("misses on a key that was never stored", () => {
    const cache = new ResultCache();
    cache.set("a", 1_000, pageWith(3));

    expect(cache.get("b", 1_000)).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("adopts the first version it is given without clearing", () => {
    const cache = new ResultCache();

    expect(cache.version).toBeNull();
    cache.set("a", 1_000, pageWith(3));

    expect(cache.version).toBe(1_000);
    expect(cache.size).toBe(1);
  });
});

describe("invalidation on reindex", () => {
  it("drops every entry when the version moves", () => {
    //This is the whole of "cleared on reindex". Every entry was computed against the same
    //corpus, so one comparison invalidates all of them — no scan, no per-entry bookkeeping.
    const cache = new ResultCache();
    cache.set("a", 1_000, pageWith(3));
    cache.set("b", 1_000, pageWith(4));

    expect(cache.get("a", 2_000)).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.version).toBe(2_000);
  });

  it("does not serve a stale entry after a reindex, even for a repeated query", () => {
    //The failure this module exists to prevent: results describing documents that were reindexed
    //out from under them, served indefinitely because the query looked identical.
    const cache = new ResultCache();
    cache.set("a", 1_000, pageWith(3));

    expect(cache.get("a", 2_000)).toBeUndefined();

    cache.set("a", 2_000, pageWith(9));
    expect(cache.get("a", 2_000)?.total).toBe(9);
  });

  it("clears on a set at a new version too, not only on a get", () => {
    //A miss followed by a `set` is the common path, and the version can move between them —
    //nothing guarantees a `get` is what notices.
    const cache = new ResultCache();
    cache.set("a", 1_000, pageWith(3));
    cache.set("b", 2_000, pageWith(4));

    expect(cache.size).toBe(1);
    expect(cache.get("a", 2_000)).toBeUndefined();
  });

  it("keeps entries while the version holds", () => {
    const cache = new ResultCache();
    cache.set("a", 1_000, pageWith(3));

    expect(cache.get("a", 1_000)?.total).toBe(3);
    expect(cache.get("a", 1_000)?.total).toBe(3);
    expect(cache.size).toBe(1);
  });

  it("treats an older version as a change, not as an ignorable one", () => {
    //A version going backwards means a restored database or a clock that moved — either way the
    //entries describe a corpus this cache can no longer vouch for. The rule is inequality, not
    //ordering, so there is no way to be tricked into keeping them.
    const cache = new ResultCache();
    cache.set("a", 2_000, pageWith(3));

    expect(cache.get("a", 1_000)).toBeUndefined();
  });
});

describe("TTL", () => {
  //The clock starts at a realistic instant rather than at zero. `lru-cache` records an entry's
  //start time and short-circuits its staleness check on `!!start`, so an entry written when the
  //clock reads exactly `0` is treated as having no start time and never expires. A real
  //`performance.now()` is a float that is never exactly zero; a fake one trivially is, and the
  //whole TTL block silently passed nothing until these were offset.
  const T0 = 1_000_000;

  it("serves an entry up to the moment it expires", () => {
    //The boundary is exclusive: an entry is stale once its age is *past* the TTL, so at exactly
    //`ttlMs` it is still served. Pinned because it is `lru-cache`'s rule rather than ours, and a
    //version of this module that changed it would be changing behaviour nothing else states.
    let clock = T0;
    const cache = new ResultCache({ ttlMs: 1_000, now: () => clock });
    cache.set("a", 1_000, pageWith(3));

    clock = T0 + 999;
    expect(cache.get("a", 1_000)?.total).toBe(3);

    clock = T0 + 1_000;
    expect(cache.get("a", 1_000)?.total).toBe(3);
  });

  it("misses once the entry has expired", () => {
    let clock = T0;
    const cache = new ResultCache({ ttlMs: 1_000, now: () => clock });
    cache.set("a", 1_000, pageWith(3));

    clock = T0 + 1_001;
    expect(cache.get("a", 1_000)).toBeUndefined();
  });

  it("never serves an expired entry, however often it is asked for", () => {
    //The contract is that it is not served. Reclaiming the memory is lazy — `lru-cache` leaves a
    //stale entry in place until eviction pressure or an overwrite reaches it, rather than arming
    //a timer per entry. That is invisible here, bounded by `maxSizeBytes`, and the version clear
    //is what actually empties this cache in practice.
    let clock = T0;
    const cache = new ResultCache({ ttlMs: 1_000, now: () => clock });
    cache.set("a", 1_000, pageWith(3));

    clock = T0 + 5_000;
    expect(cache.get("a", 1_000)).toBeUndefined();
    expect(cache.get("a", 1_000)).toBeUndefined();

    //And it is replaceable, so an expired key is not a key that is stuck.
    cache.set("a", 1_000, pageWith(7));
    expect(cache.get("a", 1_000)?.total).toBe(7);
  });

  it("restarts the TTL when a key is written again", () => {
    let clock = T0;
    const cache = new ResultCache({ ttlMs: 1_000, now: () => clock });
    cache.set("a", 1_000, pageWith(3));

    clock = T0 + 900;
    cache.set("a", 1_000, pageWith(4));
    clock = T0 + 1_500;

    expect(cache.get("a", 1_000)?.total).toBe(4);
  });
});

describe("LRU eviction", () => {
  it("evicts the oldest entry past the cap", () => {
    const cache = new ResultCache({ maxEntries: 2 });
    cache.set("a", 1_000, pageWith(1));
    cache.set("b", 1_000, pageWith(2));
    cache.set("c", 1_000, pageWith(3));

    expect(cache.size).toBe(2);
    expect(cache.get("a", 1_000)).toBeUndefined();
    expect(cache.get("b", 1_000)?.total).toBe(2);
    expect(cache.get("c", 1_000)?.total).toBe(3);
  });

  it("evicts by last read, not by last write", () => {
    //The reason `get` re-inserts. A query asked once an hour for a week is worth less than one
    //asked twice a minute, and only the read order can tell those apart — an insertion-ordered
    //map without this would evict the popular entry because it happened to be stored first.
    const cache = new ResultCache({ maxEntries: 2 });
    cache.set("a", 1_000, pageWith(1));
    cache.set("b", 1_000, pageWith(2));

    //Touch `a`, making `b` the least recently used.
    expect(cache.get("a", 1_000)?.total).toBe(1);
    cache.set("c", 1_000, pageWith(3));

    expect(cache.get("a", 1_000)?.total).toBe(1);
    expect(cache.get("b", 1_000)).toBeUndefined();
  });

  it("does not grow when an existing key is written again", () => {
    const cache = new ResultCache({ maxEntries: 2 });
    cache.set("a", 1_000, pageWith(1));
    cache.set("a", 1_000, pageWith(2));

    expect(cache.size).toBe(1);
    expect(cache.get("a", 1_000)?.total).toBe(2);
  });

  it("keeps a re-written key from being evicted as though it were old", () => {
    const cache = new ResultCache({ maxEntries: 2 });
    cache.set("a", 1_000, pageWith(1));
    cache.set("b", 1_000, pageWith(2));
    cache.set("a", 1_000, pageWith(3));
    cache.set("c", 1_000, pageWith(4));

    expect(cache.get("a", 1_000)?.total).toBe(3);
    expect(cache.get("b", 1_000)).toBeUndefined();
  });
});

describe("the byte bound", () => {
  it("evicts on retained bytes, not on entry count", () => {
    //The reason this module took a dependency instead of keeping its six-line `Map`. The entry
    //cap here is nowhere near reached — three entries against a cap of 100 — so anything evicted
    //was evicted by size. A count-based bound cannot do this, because `pageSize` is part of the
    //key and a page of 50 results costs five times a page of 10 while counting the same.
    const cache = new ResultCache({ maxEntries: 100, maxSizeBytes: 1_000 });

    cache.set("a", 1_000, pageOfSize(400));
    cache.set("b", 1_000, pageOfSize(400));
    cache.set("c", 1_000, pageOfSize(400));

    expect(cache.size).toBeLessThan(3);
    expect(cache.sizeBytes).toBeLessThanOrEqual(1_000);
    //Evicted least-recently-used first, so the newest survives.
    expect(cache.get("c", 1_000)).toBeDefined();
    expect(cache.get("a", 1_000)).toBeUndefined();
  });

  it("holds more small entries than large ones under the same cap", () => {
    //States the property in the form that matters: the cap is memory, so what fits depends on
    //what is stored. Under a count-based bound both of these would hold exactly three.
    const small = new ResultCache({ maxEntries: 100, maxSizeBytes: 2_000 });
    const large = new ResultCache({ maxEntries: 100, maxSizeBytes: 2_000 });

    for (let i = 0; i < 8; i++) small.set(`k${i}`, 1_000, pageOfSize(100));
    for (let i = 0; i < 8; i++) large.set(`k${i}`, 1_000, pageOfSize(900));

    expect(small.size).toBeGreaterThan(large.size);
    expect(small.sizeBytes).toBeLessThanOrEqual(2_000);
    expect(large.sizeBytes).toBeLessThanOrEqual(2_000);
  });

  it("reports zero retained bytes once cleared by a reindex", () => {
    const cache = new ResultCache({ maxSizeBytes: 10_000 });
    cache.set("a", 1_000, pageOfSize(200));
    expect(cache.sizeBytes).toBeGreaterThan(0);

    cache.get("a", 2_000);

    expect(cache.sizeBytes).toBe(0);
  });
});

describe("clear", () => {
  it("empties the cache but keeps the version", () => {
    const cache = new ResultCache();
    cache.set("a", 1_000, pageWith(3));

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.version).toBe(1_000);
    expect(cache.get("a", 1_000)).toBeUndefined();
  });
});
