import { readCorpusStats } from "../indexer/indexStore.js";
import type { Queryable } from "../ranking/searchStore.js";

export interface CorpusVersionOptions {
  minPollIntervalMs?: number;
  now?: () => number;
}

export const CORPUS_VERSION_DEFAULTS = {
  minPollIntervalMs: 30_000,
} as const;

export class CorpusVersion {
  readonly #db: Queryable;
  readonly #minPollIntervalMs: number;
  readonly #now: () => number;

  //the cached last-known corpus version.
  #version: number | null = null;
  //the timestamp of the last time a real database read was attempted.
  #lastPollAt = Number.NEGATIVE_INFINITY;
  //holds the in-progress database read, if one is happening right now. null means no read is currently in flight.
  #reading: Promise<number> | null = null;

  constructor(db: Queryable, options: CorpusVersionOptions = {}) {
    this.#db = db;
    this.#minPollIntervalMs = options.minPollIntervalMs ?? CORPUS_VERSION_DEFAULTS.minPollIntervalMs;
    this.#now = options.now ?? Date.now;
  }

  //A getter — lets external code read corpusVersion.last like a property
  get last(): number | null {
    return this.#version;
  }

  //current() — the public method everyone actually calls
  //Purpose: this is the one method SuggestIndex and ResultCache call. It always returns some usable version number, or throws if there's truly nothing to give.
  async current(): Promise<number> {
    try {
      return await this.#read();
    } catch (error) {
      if (this.#version === null) throw error;
      return this.#version;
    }
  }

  //#read() — the private method that does the actual work
  //Purpose: decide, on every call, which of three things to do: (a) join an already-running read, (b) return the cached value because we checked recently enough, or (c) go do a real database read.
  async #read(): Promise<number> {
    if (this.#reading !== null) return this.#reading;

    //Step 2 — check the throttle:
    //now = this.#now() — get the current time (via the injected clock).
    const now = this.#now();
    if (this.#version !== null && now - this.#lastPollAt < this.#minPollIntervalMs) {
      return this.#version;
    }
    this.#lastPollAt = now;

    //Step 4 — do the actual read, registered for dedup:
    const run = (async () => {
      //actually queries the database, destructures updatedAt out of the result.
      const { updatedAt } = await readCorpusStats(this.#db);
      this.#version = updatedAt;
      return updatedAt;
    })();

    this.#reading = run;
    try {
      return await run;
    } finally {
      this.#reading = null;
    }
  }
}
