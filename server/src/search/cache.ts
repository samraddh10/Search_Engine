//This module imports no database and does no I/O at all — not even the version poll it is
//gated on. The version is passed in, which is what keeps it a thin wrapper with two rules rather
//than a second copy of `CorpusVersion`. 3.5 is the composition root that holds both.
import { LRUCache } from "lru-cache";
import type { SearchPage } from "./queryProcessor.js";

export interface ResultCacheOptions {
  /** Hard cap on entries. A backstop against many tiny entries; `maxSizeBytes` is the real bound. */
  maxEntries?: number;
  /** Hard cap on retained bytes, measured by `estimateSize`. */
  maxSizeBytes?: number;
  /** Backstop only — invalidation is the version, not this. See the class comment. */
  ttlMs?: number;
  /** Injected for tests, exactly as `CorpusVersion` and `SuggestIndex` take one. */
  now?: () => number;
}

export const RESULT_CACHE_DEFAULTS = {
  maxEntries: 500,
  maxSizeBytes: 8_000_000,
  ttlMs: 300_000,
} as const;

//`Omit` over a union collapses it into one object type, which would quietly erase the
//`status`/`stats` correlation 3.1 built the discriminated union for — `stats: null` and
//`status: "ok"` would start typechecking together. Distributing over the members keeps the two
//shapes separate and the narrowing the compiler's job.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What is stored: a `SearchPage` without `query` and without `terms`.
 *
 * **`terms` is dropped because it is unbounded.** `TermPostings.postings` is the *full* posting
 * list for each query term, so a verbatim entry's footprint scales with `doc_freq` — one common
 * word would cache every posting in the corpus. Without it an entry is one page of results
 * carrying snippets capped at 300 characters. Nothing is lost — `terms` exists for the CLI's
 * `--explain`, and the CLI is not a cache client.
 *
 * **`query` is dropped because it is not a function of the key.** The key is the *stems*, so
 * `Documents` and `documents` share an entry — which is the point, since they are the same
 * question — but `SearchPage.query` echoes what the caller actually typed, and answering
 * `Documents` with a page that says `documents` would be returning another user's request back
 * to this one. Excluding it makes the stored value genuinely a function of its key, which is
 * the property that makes sharing the entry safe; 3.5 re-attaches the live query on the way out.
 */
export type CachedPage = DistributiveOmit<SearchPage, "query" | "terms">;

/**
 * The cache key: the stems, the page, the page size, and nothing else.
 *
 * **The raw query string is the wrong key** — `Documents`, `documents` and `documents ` are one
 * question, and keying on what was typed makes them three entries for one answer. The stems are
 * what the index was actually consulted with, so they are what identifies the result set.
 *
 * **`k1`/`b` are deliberately absent.** 3.1 put them on `SearchOptions` for the CLI and tests
 * and warned that 3.5 must not forward them from the query string: as key dimensions they are an
 * unbounded way for one caller to fill this cache, and omitting them here means a caller who
 * ignores that warning gets a wrong answer loudly rather than a memory leak quietly.
 *
 * The stems are **not** sorted. Reordering a query would be a hit if they were, but `stems` is
 * echoed inside the stored value, so a hit for `containing documents` would answer with them in
 * the other order — the same defect excluding `query` exists to avoid, traded for a rare hit.
 *
 * Encoded with `JSON.stringify` rather than joined on a separator. A separator has to be a
 * character no stem can contain, which makes this key's correctness depend on a property of
 * 2.1's tokenizer two phases away — and the failure mode there is two different queries
 * silently sharing one entry, which nothing would report. Encoding the parts removes the
 * question; the cost is a few dozen bytes per key and a call that no longer needs a comment.
 */
export function cacheKey(stems: readonly string[], page: number, pageSize: number): string {
  return JSON.stringify([stems, page, pageSize]);
}

/** Strip the two fields that must not be shared between callers. */
export function toCachedPage(page: SearchPage): CachedPage {
  const { query: _query, terms: _terms, ...rest } = page;
  return rest;
}

/**
 * Roughly how much memory an entry retains, in bytes, for `maxSize` accounting.
 *
 * The serialized length, which is an approximation and is meant to be. What matters is that it
 * *tracks* the real cost: a page is almost entirely snippet text, so its serialized length and
 * its retained size move together, and an entry ten times larger measures ten times larger. The
 * absolute number being off by JS string overhead does not change which entry gets evicted.
 *
 * Counting entries instead — the bound this subphase first shipped — is what does not track:
 * `pageSize` is a key dimension, so a page of 50 results costs five times a page of 10 while
 * counting the same, and one entry cap would cover anything from a few MB to a few dozen
 * depending on what callers happened to ask for.
 */
export function estimateSize(value: CachedPage): number {
  //`sizeCalculation` must return a positive integer; the smallest possible page still serializes
  //to well over one character, so the `|| 1` is a contract guard rather than a real case.
  return JSON.stringify(value).length || 1;
}

/**
 * In-process LRU + TTL cache of search results, dropped when the corpus is reindexed.
 *
 * Held in the API process's own RAM rather than Redis, for the reason 3.3's index is: hosted
 * Redis free tiers meter requests. The accepted tradeoffs are that the cache is cold after a
 * restart and shared with nobody — both irrelevant to a single always-on instance whose data is
 * all derivable from Postgres.
 *
 * **Eviction is `lru-cache`'s**, bounded by bytes rather than by entry count. The hand-rolled
 * `Map` this started as was six lines and correct, but it could only count entries, and entries
 * are not uniform: `pageSize` is part of the key, so one cap covered a range of real memory
 * rather than a number. `maxSize` with a `sizeCalculation` is the feature worth taking the
 * dependency for; nothing else about this class changed with it.
 *
 * **It does not poll.** The version is an argument to `get` and `set`. The obvious build — take
 * a `Queryable`, check `corpus_stats.updated_at` on the way in — would reproduce
 * `CorpusVersion`'s throttle, its in-flight dedup and its degrade rule, and leave two staleness
 * policies to keep in agreement. Passing the number in makes invalidation a comparison and a
 * branch, and leaves this module with no I/O to test around.
 *
 * **The TTL is a backstop, not the invalidation mechanism.** Invalidation here is *exact*: the
 * version moves, the cache clears, and no entry outlives the corpus it describes. A TTL's usual
 * job is bounding how wrong a stale entry can get, and that is already done. It stays because it
 * costs nothing here and covers the one case the version cannot — a signal that silently stops
 * moving, from an indexer that died before writing `corpus_stats`, leaving a cache confidently
 * serving a corpus that no longer exists.
 */
export class ResultCache {
  readonly #entries: LRUCache<string, CachedPage>;

  //`null` means "nothing cached under any version yet", which keeps the first `get` from
  //counting as a version change and clearing an already-empty cache.
  #version: number | null = null;

  constructor(options: ResultCacheOptions = {}) {
    const now = options.now;
    this.#entries = new LRUCache<string, CachedPage>({
      max: options.maxEntries ?? RESULT_CACHE_DEFAULTS.maxEntries,
      maxSize: options.maxSizeBytes ?? RESULT_CACHE_DEFAULTS.maxSizeBytes,
      ttl: options.ttlMs ?? RESULT_CACHE_DEFAULTS.ttlMs,
      sizeCalculation: estimateSize,
      //`lru-cache` debounces its clock reads behind a `setTimeout` by default, which is a real
      //timer this module has no other reason to create and which a test with an injected clock
      //cannot advance. Our TTL is minutes and a `now()` call per lookup is free, so the
      //debounce buys nothing and costs the ability to test the expiry.
      ttlResolution: 0,
      //The clock, when a test supplies one. `lru-cache`'s own docs call this out as a testing
      //seam rather than a production knob, which is exactly how it is used: omitted, the cache
      //takes the platform clock.
      ...(now === undefined ? {} : { perf: { now } }),
    });
  }

  /** How many entries are held; `0` before anything is cached. */
  get size(): number {
    return this.#entries.size;
  }

  /** Roughly how many bytes those entries retain, by `estimateSize`. */
  get sizeBytes(): number {
    return this.#entries.calculatedSize;
  }

  /** The corpus version the current entries were computed against; `null` before the first use. */
  get version(): number | null {
    return this.#version;
  }

  /**
   * The cached page for this key at this corpus version, or `undefined` for a miss.
   *
   * A version that disagrees with the one the cache was filled at empties it first, so a reindex
   * cannot be served around: every entry in here describes a corpus that no longer exists.
   */
  get(key: string, version: number): CachedPage | undefined {
    this.#syncVersion(version);
    //`get` is what makes this least-recently-*used* rather than least-recently-written: reading
    //an entry moves it to the front of `lru-cache`'s recency order. A query asked twice a minute
    //should outlive one asked once an hour, and only the read order can tell those apart.
    return this.#entries.get(key);
  }

  /**
   * Cache a page under this key at this corpus version.
   *
   * The version is taken again rather than trusted from the preceding `get`, because a reindex
   * can land *between* the miss and the query that filled it. Passing the version read before
   * that query — 3.4's ordering rule, the same one `SuggestIndex.#rebuild` follows — means such
   * a page is stored under the old version and dropped by the next `get`, rather than stamped
   * fresh and served until something else moves the column.
   */
  set(key: string, version: number, value: CachedPage): void {
    this.#syncVersion(version);
    this.#entries.set(key, value);
  }

  /** Drop everything, keeping the current version. For 3.5's tests and an explicit reset. */
  clear(): void {
    this.#entries.clear();
  }

  #syncVersion(version: number): void {
    if (this.#version === version) return;
    //A moved version invalidates every entry at once — they were all computed against the same
    //corpus. This is the whole of "cleared on reindex": no scan, no per-entry stamp, no
    //bookkeeping to get wrong.
    this.#entries.clear();
    this.#version = version;
  }
}
