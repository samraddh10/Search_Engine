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

  let frontierDrained = false;

  for (const seed of seeds) {
    const added = await frontier.addSeed(seed);
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

    if (active.size >= concurrency) {
      await settleOne();
      continue;
    }

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

  await Promise.allSettled(active);

  for (const entry of hosts.drain()) {
    if (await giveBack(entry)) summary.returnedToFrontier++;
  }

  summary.elapsedMs = Date.now() - startedAt;
  summary.frontier = frontier.stats;

  return summary;

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

  async function settleOne(): Promise<void> {
    if (active.size === 0) return;
    await Promise.race(active);
  }

  async function processOne(entry: QueuedUrl): Promise<void> {
    let cooldownMs = defaultCrawlDelayMs;

    try {
      const robots = await checkRobots(entry.url, { ...robotsOptions, signal });

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
          return;
        }

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
    } finally {
      hosts.release(entry.url, cooldownMs);
    }
  }

  async function giveBack(entry: QueuedUrl): Promise<boolean> {
    const result = await frontier.requeue(entry.url, { depth: entry.depth });
    if (result.added) frontierDrained = false;

    return result.added;
  }

  function bumpRequeues(url: string): number {
    const next = (requeueCounts.get(url) ?? 0) + 1;
    requeueCounts.set(url, next);

    return next;
  }
}

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
