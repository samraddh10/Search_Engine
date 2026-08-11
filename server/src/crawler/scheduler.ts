import {
  FETCH_FAILURE_REASONS,
  fetchPage,
  type FetchFailureReason,
  type FetchOptions,
} from "./fetcher.js";
import type { Frontier, FrontierStats } from "./frontier.js";
import type { QueuedUrl } from "./frontierStore.js";
import { HostScheduler } from "./hostScheduler.js";
import { parseHtml, type ParsedPage, type ParseOptions } from "./parser.js";
import { checkRobots, type RobotsOptions } from "./robots.js";

export const CRAWL_DEFAULTS = {
  concurrency: 4,
  maxPages: 100,
  defaultCrawlDelayMs: 1_000,
  maxRequeues: 2,
  batchFactor: 4,
} as const;

export interface CrawledPage {
  page: ParsedPage;
  depth: number;
  requestedUrl: string;
  url: string;
  status: number;
  contentType: string;
  charset: string;
  bytes: number;
  fetchedAt: Date;
}

/**
 * Why a URL left the crawl without producing a page. `parse-failed` is not a
 * `FetchFailureReason` — the bytes arrived, they just weren't usable HTML — so the union is
 * widened here rather than in 1.1.
 */
export type CrawlFailureReason = FetchFailureReason | "parse-failed";

/**
 * Reported once per URL, and only when the crawl has *given up* on it: a retryable failure
 * that still has requeues left is not a failure yet. Robots-blocked URLs are deliberately
 * not reported — a disallow-all host would emit thousands of them, and being told not to
 * fetch something is policy working, not an error.
 */
export interface CrawlFailure {
  url: string;
  depth: number;
  reason: CrawlFailureReason;
  status?: number;
  detail: string;
  retryable: boolean;
  /**
   * Scheduling rounds this URL cost — 1 plus the number of times it was requeued. Not
   * `FetchFailure.attempts`, which counts HTTP requests inside a single `fetchPage` call.
   */
  rounds: number;
}

export type CrawlStopReason = "drained" | "max-pages" | "aborted";

export interface CrawlSummary {
  stoppedBecause: CrawlStopReason;
  fetched: number;
  delivered: number;
  failed: number;
  failuresByReason: Record<FetchFailureReason, number>;
  gaveUp: number;
  robotsBlocked: number;
  parseFailed: number;
  //requeued — how many URLs were put back in the queue for a retry.
  requeued: number;
  linksDiscovered: number;
  returnedToFrontier: number;
  errors: number;
  elapsedMs: number;
  frontier: FrontierStats;
}

export interface CrawlOptions {
  frontier: Frontier;
  seeds: readonly string[];
  concurrency?: number;
  maxPages?: number;
  batchSize?: number;
  defaultCrawlDelayMs?: number;
  maxRequeues?: number;
  onPage?: (page: CrawledPage) => void | Promise<void>;
  onFailure?: (failure: CrawlFailure) => void | Promise<void>;
  //onError? — called when a worker throws unexpectedly.
  onError?: (error: unknown, url: string) => void;
  signal?: AbortSignal;
  fetchOptions?: Omit<FetchOptions, "signal">;
  robotsOptions?: Omit<RobotsOptions, "signal">;
  parseOptions?: ParseOptions;
  now?: () => number;
}

export async function crawl(options: CrawlOptions): Promise<CrawlSummary> {
  const {
    frontier,
    seeds,
    concurrency = CRAWL_DEFAULTS.concurrency,
    maxPages = CRAWL_DEFAULTS.maxPages,
    batchSize = Math.max(concurrency * CRAWL_DEFAULTS.batchFactor, 1),
    defaultCrawlDelayMs = CRAWL_DEFAULTS.defaultCrawlDelayMs,
    maxRequeues = CRAWL_DEFAULTS.maxRequeues,
    onPage,
    onFailure,
    onError,
    signal,
    fetchOptions,
    robotsOptions,
    parseOptions,
    now,
  } = options;

  const startedAt = Date.now();
  const hosts = new HostScheduler({ now });
  const requeueCounts = new Map<string, number>();
  const active = new Set<Promise<void>>();

  const summary = {
    stoppedBecause: "drained" as CrawlStopReason,
    fetched: 0,
    delivered: 0,
    failed: 0,
    //FETCH_FAILURE_REASONS is presumably an array like ["timeout", "dns-error", "http-error", ...]. .map(reason => [reason, 0]) 
    // turns that into an array of pairs: [["timeout", 0], ["dns-error", 0], ...]. Object.fromEntries(...) is a built-in JS function that turns an array of [key, value] pairs 
    // into a plain object: { timeout: 0, "dns-error": 0, "http-error": 0, ... }. So instead of hand-writing every possible failure reason with : 0, it builds the zeroed-out 
    // lookup table automatically from the single source-of-truth array — if fetcher.ts ever adds a new failure reason, this code doesn't need to change.
    failuresByReason: Object.fromEntries(
      FETCH_FAILURE_REASONS.map((reason) => [reason, 0]),
    ) as Record<FetchFailureReason, number>,
    gaveUp: 0,
    robotsBlocked: 0,
    parseFailed: 0,
    requeued: 0,
    linksDiscovered: 0,
    returnedToFrontier: 0,
    errors: 0,
    elapsedMs: 0,
    frontier: frontier.stats,
  };

  //A flag: once the frontier tells us "I have nothing more right now," we remember that instead of asking it again on every single loop iteration
  let frontierDrained = false;

  for (const seed of seeds) {
    const added = await frontier.addSeed(seed);
    //If anything got added, we make sure frontierDrained is false — there's real work now.
    if (added.added) frontierDrained = false;
  }

  for (;;) {
    if (signal?.aborted) {
      summary.stoppedBecause = "aborted";
      break;
    }

    if (summary.fetched >= maxPages) {
      summary.stoppedBecause = "max-pages";
      break;
    }

    //If we already have concurrency (4) fetches running, don't start a 5th.
    if (active.size >= concurrency) {
      await settleOne();
      continue;
    }

    //hosts.buffered is presumably a count of how many URLs are sitting in the HostScheduler's internal buffer
    if (hosts.buffered < concurrency && !frontierDrained) await refill();

    const dispatch = hosts.next();

    if (dispatch.type === "ready") {
      launch(dispatch.entry);
      continue;
    }

    if (dispatch.type === "blocked") {
      await settleOne();
      continue;
    }

    if (dispatch.type === "wait") {
      const wait = countdown(dispatch.waitMs, signal);
      try {
        await (active.size === 0 ? wait.elapsed : Promise.race([settleOne(), wait.elapsed]));
      } finally {
        wait.cancel();
      }
      continue;
    }

    if (active.size > 0) {
      await settleOne();
      continue;
    }

    summary.stoppedBecause = "drained";
    break;
  }

  //Even after break, some fetches might still be running (e.g. if we stopped because of maxPages or aborted, mid-flight requests were allowed to finish rather than being yanked). 
  // Promise.allSettled waits for every one of them to finish — succeed or fail
  await Promise.allSettled(active);

  for (const entry of hosts.drain()) {
    if (await giveBack(entry)) summary.returnedToFrontier++;
  }

  summary.elapsedMs = Date.now() - startedAt;
  summary.frontier = frontier.stats;

  return summary;

  //Figures out how many more URLs we'd like buffered (batchSize minus what's already there).
  //If we're already full enough, do nothing. Otherwise ask the frontier for that many URLs.
  //If it hands back zero, remember frontierDrained = true so we stop pestering it.
  //Otherwise, give the batch to the HostScheduler so it can sort them by host.
  async function refill(): Promise<void> {
    const wanted = batchSize - hosts.buffered;
    if (wanted <= 0) return;

    const batch = await frontier.popBatch(wanted);
    if (batch.length === 0) {
      frontierDrained = true;
      return;
    }

    hosts.add(batch);
  }
//This is where concurrency actually happens:
  function launch(entry: QueuedUrl): void {
    let task: Promise<void>;

    task = processOne(entry)
      .catch((error: unknown) => {
        summary.errors++;
        onError?.(error, entry.url);
      })
      .finally(() => {
        active.delete(task);
      });

    active.add(task);
  }

  //Waits for whichever currently-running task finishes first.
  //The guard at the top exists because Promise.race on an empty collection never resolves at all
  //it would hang the whole crawl forever if called with nothing running.
  async function settleOne(): Promise<void> {
    if (active.size === 0) return;
    await Promise.race(active);
  }

  //This is the core logic for handling exactly one URL, start to finish.
  async function processOne(entry: QueuedUrl): Promise<void> {
    let cooldownMs = defaultCrawlDelayMs;

    try {
      const robots = await checkRobots(entry.url, { ...robotsOptions, signal });

      //If we got cancelled while the robots check was running, checkRobots may have returned "not allowed" simply as a side effect of aborting — not because the site genuinely disallows it.
      //So this checks the signal before trusting the robots answer, and if aborted, just hands the URL back untouched (no penalty, no "robots blocked" miscount) and stops.
      if (signal?.aborted) {
        await giveBack(entry);
        return;
      }

      cooldownMs = robots.crawlDelayMs ?? defaultCrawlDelayMs;

      if (!robots.allowed) {
        summary.robotsBlocked++;
        if (robots.source !== "network") cooldownMs = 0;
        return;
      }

      const result = await fetchPage(entry.url, { ...fetchOptions, signal });

      if (result.ok) {
        summary.fetched++;

        if (result.url !== entry.url) await frontier.markSeen(result.url);

        const parsed = parseHtml(result.body, result.url, parseOptions);
        if (!parsed) {
          summary.parseFailed++;
          await onFailure?.({
            url: entry.url,
            depth: entry.depth,
            reason: "parse-failed",
            status: result.status,
            detail: `could not parse ${result.contentType || "response"} as HTML`,
            retryable: false,
            rounds: roundsFor(entry.url),
          });
          return;
        }

        //For every link found on the page, try adding it to the frontier at depth + 1 (one hop deeper than the current page), resolving any relative links against result.url
        //If it was genuinely new (not a dupe), count it, and un-set frontierDrained — there's fresh work available now.
        for (const link of parsed.links) {
          const added = await frontier.add(link, { depth: entry.depth + 1, base: result.url });
          if (added.added) {
            summary.linksDiscovered++;
            frontierDrained = false;
          }
        }

        await onPage?.({
          page: parsed,
          depth: entry.depth,
          requestedUrl: result.requestedUrl,
          url: result.url,
          status: result.status,
          contentType: result.contentType,
          charset: result.charset,
          bytes: result.bytes,
          fetchedAt: new Date(),
        });
        summary.delivered++;
        return;
      }

      if (result.reason === "aborted") {
        await giveBack(entry);
        return;
      }

      if (result.retryAfterMs !== undefined) {
        cooldownMs = Math.max(cooldownMs, result.retryAfterMs);
      }

      // Read before the bump below: bumpRequeues() increments as a side effect of the
      // retry decision, so asking afterwards counts this dispatch twice.
      const rounds = roundsFor(entry.url);

      //If this failure type is one fetchPage flagged as worth retrying (e.g. a timeout, a 503), and we haven't exceeded maxRequeues for this specific URL 
      // (bumpRequeues increments the counter and returns the new total
      //try putting it back in the frontier at its original depth. If that succeeds, count it and stop — this URL isn't "failed," it's just going around again later.
      if (result.retryable && bumpRequeues(entry.url) <= maxRequeues) {
        const requeued = await frontier.requeue(entry.url, { depth: entry.depth });
        if (requeued.added) {
          summary.requeued++;
          frontierDrained = false;
          return;
        }
      }

      summary.failed++;
      summary.failuresByReason[result.reason]++;
      if (result.retryable) summary.gaveUp++;

      await onFailure?.({
        url: entry.url,
        depth: entry.depth,
        reason: result.reason,
        status: result.status,
        detail: result.message,
        retryable: result.retryable,
        rounds,
      });
    } finally {
      hosts.release(entry.url, cooldownMs);
    }
  }

  //Puts a URL back into the frontier without going through bumpRequeues
  //this is specifically for cases where the crawl itself gave up on the URL (shutdown/abort)
  async function giveBack(entry: QueuedUrl): Promise<boolean> {
    const result = await frontier.requeue(entry.url, { depth: entry.depth });
    if (result.added) frontierDrained = false;

    return result.added;
  }

  //Looks up the current requeue count for this URL in the Map (?? 0 if it's never been requeued before), adds one, saves it back, and returns the new total — used to enforce maxRequeues.
  function bumpRequeues(url: string): number {
    const next = (requeueCounts.get(url) ?? 0) + 1;
    requeueCounts.set(url, next);

    return next;
  }

  // The first dispatch is a round the map never recorded — it only holds URLs that have
  // already failed retryably — so the count is one more than the requeues.
  function roundsFor(url: string): number {
    return (requeueCounts.get(url) ?? 0) + 1;
  }
}

//countdown(ms, signal) — the standalone timer helper
function countdown(
  ms: number,
  signal?: AbortSignal,
): { elapsed: Promise<void>; cancel: () => void } {
  let cancel = (): void => {};

  const elapsed = new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    cancel = finish;
  });

  return { elapsed, cancel };
}
