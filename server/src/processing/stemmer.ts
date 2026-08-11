//Reduces inflected forms to a shared root so a search for "computer" finds a page that only
//ever says "computing". Porter's algorithm — a fixed sequence of suffix rewrites, no
//dictionary and no training data.
//
//The `stemmer` package rather than `natural`, which the plan originally named: same
//algorithm, 12.9 KB against 13.8 MB, zero dependencies against fourteen. `natural` would
//have installed mongoose, a second Redis client and a second `pg` driver into a project that
//already has one of those and deliberately does not use the other two, and it is CommonJS,
//so it would have needed the same import workaround already documented for ioredis and
//robots-parser. This one is native ESM and ships its own types.
import { stemmer } from "stemmer";

//Nothing outside this module imports `stemmer` directly. The indirection is what makes the
//algorithm swappable — an index built with one stemmer and queried with another silently
//returns nothing, so if this is ever changed the whole corpus must be reindexed, and having
//exactly one call site is what makes that a one-line change rather than a hunt.

//Bounded so a long-running API process cannot grow this without limit: /search takes
//arbitrary user input, and an unbounded cache keyed on it is a slow memory leak that only
//shows up in production. Once full it stops accepting new entries rather than evicting —
//by that point it holds the corpus's actual vocabulary, which is the part that repeats, and
//an LRU's bookkeeping would cost more than the misses it saves.
const MAX_CACHE_ENTRIES = 50_000;

const cache = new Map<string, string>();

/**
 * Stem one *normalized* token. Input is expected to be lowercase and free of punctuation —
 * i.e. the output of `normalizeToken` — because Porter's rules are defined over lowercase
 * ASCII-ish words and an uppercase or accented input silently falls through most of them.
 *
 * Memoized: a corpus repeats the same few thousand words tens of thousands of times, so
 * nearly every call after the first few pages is a hash lookup.
 */
export function stem(word: string): string {
  const cached = cache.get(word);
  if (cached !== undefined) return cached;

  const stemmed = stemmer(word);
  if (cache.size < MAX_CACHE_ENTRIES) cache.set(word, stemmed);

  return stemmed;
}

/** Drop the memo table. For tests and for 2.5's reindex path; correctness never depends on it. */
export function clearStemCache(): void {
  cache.clear();
}
