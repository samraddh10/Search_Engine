import { LRUCache } from "lru-cache";
import type { SearchPage } from "./queryProcessor.js";

export interface ResultCacheOptions {
  //a ceiling on the raw count of cached pages, described as "a backstop against many tiny entries" — i.e., a safety net in case someone somehow floods the cache with lots of tiny cheap entries that don't hit the byte cap.
  maxEntries?: number;
  //the real bound: total estimated memory the cache is allowed to retain, in bytes.
  maxSizeBytes?: number;
  //how long an entry survives even if nothing invalidates it — the "backstop" mentioned in the class doc
  ttlMs?: number;
  //lets tests fake the passage of time instead of waiting on real timers.
  now?: () => number;
}

export const RESULT_CACHE_DEFAULTS = {
  maxEntries: 500,
  maxSizeBytes: 8_000_000,
  ttlMs: 300_000,
} as const;

//This isn't a runtime function — it exists only for the TypeScript compiler — but it deserves the same purpose-then-mechanics treatment, because it's solving a real, sneaky problem.
//TypeScript's built-in Omit<T, K> type has a well-known gotcha: when T is a union of several object shapes (a discriminated union), 
// plain Omit does not keep them separate. It effectively flattens the union down into one shape built only from the properties shared across every union member.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

//This is literally "a SearchPage, minus the query and terms fields," with the union-safety from above.
export type CachedPage = DistributiveOmit<SearchPage, "query" | "terms">;

//Builds the string used as the cache's lookup key — the "address" a search result is filed under.
export function cacheKey(stems: readonly string[], page: number, pageSize: number): string {
  return JSON.stringify([stems, page, pageSize]);
}

//Converts a full SearchPage (the real result of running a search) into the trimmed-down CachedPage shape that's safe to store.
export function toCachedPage(page: SearchPage): CachedPage {
  const { query: _query, terms: _terms, ...rest } = page;
  return rest;
}

//Tells lru-cache roughly how many "bytes" a given cached entry costs, so the cache can enforce maxSizeBytes (a true memory budget) instead of a flat entry count.
export function estimateSize(value: CachedPage): number {
  return JSON.stringify(value).length || 1;
}

//One instance = the API's single shared "remember recent search results, but only for as long as they're describing the current corpus" cache. 
// It wraps a real LRUCache from the npm library, and layers exactly one extra rule on top: every read and write must also state which corpus version it belongs to, and a version change nukes everything.
export class ResultCache {
  readonly #entries: LRUCache<string, CachedPage>;

  #version: number | null = null;

  constructor(options: ResultCacheOptions = {}) {
    const now = options.now;
    this.#entries = new LRUCache<string, CachedPage>({
      max: options.maxEntries ?? RESULT_CACHE_DEFAULTS.maxEntries,
      maxSize: options.maxSizeBytes ?? RESULT_CACHE_DEFAULTS.maxSizeBytes,
      ttl: options.ttlMs ?? RESULT_CACHE_DEFAULTS.ttlMs,
      sizeCalculation: estimateSize,
      ttlResolution: 0,
      ...(now === undefined ? {} : { perf: { now } }),
    });
  }

  get size(): number {
    return this.#entries.size;
  }

  get sizeBytes(): number {
    return this.#entries.calculatedSize;
  }

  get version(): number | null {
    return this.#version;
  }

  get(key: string, version: number): CachedPage | undefined {
    this.#syncVersion(version);
    return this.#entries.get(key);
  }

  set(key: string, version: number, value: CachedPage): void {
    this.#syncVersion(version);
    this.#entries.set(key, value);
  }

  clear(): void {
    this.#entries.clear();
  }

  #syncVersion(version: number): void {
    if (this.#version === version) return;
    this.#entries.clear();
    this.#version = version;
  }
}
