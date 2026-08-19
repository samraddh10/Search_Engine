//It takes its client as an argument, like `DocumentStore`, `indexStore` and `searchStore` —
//`search/` imports no database, and 3.5 is the composition root that owns connections.
import type { Suggestion } from "shared";
import { SUGGESTION_LIMIT } from "shared";
import { normalizeToken } from "../processing/normalizer.js";
import type { Queryable } from "../ranking/searchStore.js";
import { CorpusVersion } from "./corpusVersion.js";

export interface SuggestOptions {
  limit?: number;
}

export interface SuggestIndexOptions {
  /**
   * The shared reindex poll. 3.5 passes one instance to every consumer that goes stale — this
   * index and 3.4's result cache — so a request costs one version read rather than one each.
   *
   * Omitted, this index builds its own from `db`, which is what the tests and any single-consumer
   * caller want.
   */
  version?: CorpusVersion;
  /** Forwarded to the `CorpusVersion` built when `version` is not supplied. */
  minPollIntervalMs?: number;
  /** Injected for tests, exactly as `HostScheduler` takes one. Forwarded like `minPollIntervalMs`. */
  now?: () => number;
}

/** One row of the in-memory index: a display spelling and the weight it is ranked by. */
interface TermEntry {
  surface: string;
  docFreq: number;
}

//Purpose: This is the comparator used to keep the in-memory array sorted alphabetically (in a very specific, deliberate sense of "alphabetically" — see below). This sort order is what makes binary search possible in lowerBound.
function bySurface(a: TermEntry, b: TermEntry): number {
  if (a.surface < b.surface) return -1;
  if (a.surface > b.surface) return 1;
  return 0;
}

/**
 * Ranking order: most documents first, then shortest, then alphabetical.
 *
 * The tie-breaks are not decoration. `doc_freq` ties are the common case on a small corpus, and
 * an order that falls out of however Postgres returned the rows shows two users different
 * suggestions for the same prefix over the same data — the rule 2.2 set for `pickSurfaceForm`
 * and 2.4 set for `docId`, in the third place it comes up. Shortest-first is also the better
 * answer for a person: `car` before `cardiovascular` when both are equally common.
 */
//Purpose: Once you've found which terms match a prefix, this decides which order to show them in — i.e., which ones are the "best" suggestions when there are more matches than the requested limit.
function byRank(a: TermEntry, b: TermEntry): number {
  //the term that appears in more documents wins. It's b - a which makes it descending order(higher frequency first).
  if (a.docFreq !== b.docFreq) return b.docFreq - a.docFreq;
  //if two terms are equally popular, prefer the shorter one.
  if (a.surface.length !== b.surface.length) return a.surface.length - b.surface.length;
  //if it's still tied, fall back to alphabetical order, purely for determinism.
  return bySurface(a, b);
}

//Purpose: Given the sorted array, find the first index whose surface is >= prefix. This is the starting point of the block of terms that might match the user's typed prefix — found in O(log n) time instead of scanning the whole array from the front.
function lowerBound(entries: readonly TermEntry[], prefix: string): number {
  let lo = 0;
  let hi = entries.length;

  while (lo < hi) {
  //>>> 1 is "unsigned right shift by 1", which is a fast way to do integer division by 2
    const mid = (lo + hi) >>> 1;
    //Non-null: `mid < hi <= entries.length`, so the index is always in range.
    if (entries[mid]!.surface < prefix) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

//Purpose: Autocomplete for a multi-word query should only complete the last word. If someone has typed "web cr", you want to suggest "web crawler", not just "crawler" 
// — and you don't want to hand the caller a bare fragment and make them figure out how to splice it back onto the rest of the input (that splice point is exactly where off-by-one bugs live).
function splitInput(input: string): { head: string; fragment: string } {
  const match = /\s(?=\S*$)/.exec(input);
  if (match === null) return { head: "", fragment: input };

  const cut = match.index + 1;
  return { head: input.slice(0, cut), fragment: input.slice(cut) };
}

/**
 * In-process autocomplete over `terms.surface_form`, refreshed when the index is rebuilt.
 *
 * Held in the API process's own RAM rather than Redis: hosted Redis free tiers meter requests
 * and `/suggestions` fires per keystroke, which made a ZSET simultaneously the slowest and the
 * costliest option. At ~10k terms the array costs single-digit MB and is fully expendable — a
 * restart rebuilds it with one query.
 */
export class SuggestIndex {
  readonly #db: Queryable;
  //The poll, which this class no longer owns — see `CorpusVersion`. What it still owns is the
  //*reaction* to a version change, which is the expensive half and the half nothing else shares.
  readonly #watcher: CorpusVersion;

  //`null` means "never built", which is distinct from "built and empty" — an empty corpus is a
  //real answer, and conflating the two would re-query `terms` on every keystroke forever.
  //#entries — the actual in-memory cache.
  #entries: TermEntry[] | null = null;
  //#version — records which corpus_stats.updated_at value the current #entries reflects. This is how staleness gets detected.
  #version = 0;
  //In-flight dedup, the same shape 1.2 used for concurrent robots.txt fetches: a burst of
  //keystrokes arriving just after a reindex must not each start their own rebuild.
  #rebuilding: Promise<void> | null = null;

  constructor(db: Queryable, options: SuggestIndexOptions = {}) {
    this.#db = db;
    this.#watcher =
      options.version ??
      new CorpusVersion(db, { minPollIntervalMs: options.minPollIntervalMs, now: options.now });
  }

  /** How many terms are currently indexed; `0` before the first build. */
  get size(): number {
    return this.#entries?.length ?? 0;
  }

  /** The `corpus_stats.updated_at` this index was built from, as epoch ms; `0` before the first build. */
  get version(): number {
    return this.#version;
  }

  /**
   * Suggest completions for what the user has typed so far.
   *
   * Returns `[]` rather than throwing for every degenerate input — a trailing space, a fragment
   * that normalizes away to nothing, an empty corpus. None of those is a client error, and an
   * autocomplete that raises while someone is typing is worse than one that stays quiet.
   */
  async suggest(input: string, options: SuggestOptions = {}): Promise<Suggestion[]> {
    //use the caller's limit, or the shared default.
    const limit = options.limit ?? SUGGESTION_LIMIT;
    //split into "already typed" and "still being typed."
    const { head, fragment } = splitInput(input);

    //Normalize *only* — deliberately not `processQuery`, which is the query-side entry point
    //everywhere else in this repo. It would be wrong here twice over, and both failures return
    //an empty list rather than a wrong one, so neither would announce itself: it stems, and the
    //stem of a partial word matches nothing (`comp` stays `comp` while the array holds
    //`computer`), and it drops stopwords, so typing `th` on the way to `throughput` would find
    //nothing at all. `normalizeToken` is the one step that makes typed text comparable to a
    //stored `surface_form`, because it is the step 2.1 used to produce those surfaces.
    const prefix = normalizeToken(fragment);
    if (prefix === "" || limit <= 0) return [];

    await this.#maybeRefresh();

    const entries = this.#entries;
    if (entries === null || entries.length === 0) return [];

    return this.#topMatches(entries, prefix, limit).map((entry) => ({
      term: head + entry.surface,
      weight: entry.docFreq,
    }));
  }

  ///Purpose: a public method to force an unconditional rebuild, ignoring both the poll throttle and the version check. Meant to be called exactly once, at server startup,
  //  by 3.5 (the composition root) — without being awaited — so that the first real user request already finds a warm cache instead of paying a database round-trip on someone's very first keystroke.
  async refresh(): Promise<void> {
    await this.#rebuild();
  }

  //#topMatches() — collecting and ranking the prefix block
  //Purpose: given the full array, a normalized prefix, and a limit, find every entry that starts with that prefix and return the best limit of them, ranked by byRank.
  #topMatches(entries: readonly TermEntry[], prefix: string, limit: number): TermEntry[] {
    //The array is sorted by surface, so the matches are contiguous and the binary search finds
    //where they start. The *ranking* is by `doc_freq`, though, which is unordered inside that
    //range — so the top few cannot be read off the front and the whole range has to be scanned.
    //That cost is bounded by the vocabulary rather than the corpus: a one-character prefix over
    //~10k terms scans a few thousand entries of a flat array, which is nothing beside the round
    //trip the request has already paid. If the vocabulary ever outgrows that, the escape hatch
    //recorded in the plan is to cap the index to the top N terms by `doc_freq`, which changes
    //nothing outside this class.
    const matches: TermEntry[] = [];
    for (let i = lowerBound(entries, prefix); i < entries.length; i++) {
      const entry = entries[i]!;
      if (!entry.surface.startsWith(prefix)) break;
      matches.push(entry);
    }

    return matches.sort(byRank).slice(0, limit);
  }

  //Purpose: this is the librarian glancing at the "last reorganized" sign on the archive door. Called at the start of every suggest()
  async #maybeRefresh(): Promise<void> {
    //A rebuild already running is enough: answer from whatever is in hand rather than making a
    //keystroke wait behind it. A suggestion one reindex out of date is invisible to a user; a
    //stalled keystroke is not.
    if (this.#rebuilding !== null) return;

    try {
      //The throttle, the in-flight dedup of the read itself and the degrade-on-blip rule all
      //live in `CorpusVersion` now, shared with 3.4's result cache. What is left here is the
      //only part that was ever specific to this class: comparing the number against the one the
      //current array was built from, and rebuilding when they differ.
      const version = await this.#watcher.current();
      if (this.#entries !== null && version === this.#version) return;
      await this.#rebuild(version);
    } catch (error) {
      //Serving a slightly stale array beats failing a keystroke, so a blip is swallowed *if*
      //there is something to serve — the same call this plan made in 1.2, where a dead Redis
      //degrades the crawl to fetching robots.txt more often rather than stopping it. With
      //nothing built yet there is no degraded mode to fall back to, so the error propagates and
      //3.5 reports it honestly. (`CorpusVersion` applies the same rule to the *read*, so what
      //reaches here is a version read that never once succeeded, or a failure of the rebuild
      //query below.)
      if (this.#entries === null) throw error;
    }
  }

  //Purpose: does the actual work of pulling every usable term out of the terms table, sorting it, and atomically swapping it in as the new #entries
  async #rebuild(knownVersion?: number): Promise<void> {
    //in-flight dedup: if a rebuild is already running, don't start a second one
    if (this.#rebuilding !== null) return this.#rebuilding;

    //defines a small async function and calls it immediately, capturing the resulting promise in run before doing anything else with it.
    const run = (async () => {
      //Read the version *before* the rows, always. An entry stamped with a version read after
      //its data can hold pre-reindex rows wearing a post-reindex number, and the comparison in
      //`#maybeRefresh` will never catch it — stale until something unrelated moves the column.
      //Read first and the failure mode inverts into a redundant rebuild on the next poll, which
      //costs one query and is self-correcting. (This branch is `refresh()`'s: `#maybeRefresh`
      //already read the version before calling in, and passes it as `knownVersion`.)
      const version = knownVersion ?? (await this.#watcher.current());

      //`surface_form IS NOT NULL` at the source, so the in-memory rows carry no nullable field
      //to re-check on the hot path. The `COALESCE(surface_form, term)` that 0.4 originally
      //planned is deliberately *not* used: it falls back to a bare stem, and showing a human
      //`comput` is the exact breakage this column was added to prevent. 2.3 populates the
      //column for every term it writes, so this filter discards rows that should not exist.
      //
      //No `ORDER BY` — see `bySurface` for why the sort has to happen in JS.
      const { rows } = await this.#db.query<{ surface_form: string; doc_freq: number }>(
        "SELECT surface_form, doc_freq FROM terms WHERE surface_form IS NOT NULL",
      );

      const entries = rows.map((row) => ({ surface: row.surface_form, docFreq: row.doc_freq }));
      entries.sort(bySurface);

      //Swapped in as a unit, so a concurrent `suggest()` reads either the whole old array or
      //the whole new one and never a half-filled build.
      this.#entries = entries;
      this.#version = version;
    })();

    this.#rebuilding = run;
    try {
      await run;
    } finally {
      this.#rebuilding = null;
    }
  }
}
