//Phase 1.7 — the crawler's entry point, and the composition root for everything in 1.1-1.6.
//
//Those six modules deliberately take their dependencies as arguments: `crawl()` accepts an
//already-built `Frontier`, `RedisFrontierStore` an already-built client, `DocumentStore` a
//`Queryable` rather than the pool. That was all so this file could be the *single* place
//that answers "is Redis configured?", opens connections and closes them. Keep it that way —
//an import of `db/redis.js` anywhere under `crawler/` other than here undoes it.
import { checkPgHealth, closePg, pgPool } from "../db/pg.js";
import { closeRedis, connectRedis, redisClient } from "../db/redis.js";
import { USAGE, parseCrawlArgs } from "./cliArgs.js";
import { Frontier, hostsFromSeeds } from "./frontier.js";
import {
  MemoryFrontierStore,
  RedisFrontierStore,
  type FrontierStore,
} from "./frontierStore.js";
import {
  crawl,
  type CrawlFailure,
  type CrawlSummary,
  type CrawledPage,
} from "./scheduler.js";
import { DocumentStore, type DocumentStoreStats } from "./store.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
//128 + SIGINT, the shell convention. A wrapper script needs to be able to tell "the crawl
//finished" from "someone stopped it half-way", and an interrupted crawl has by definition
//not covered the ground it was asked to.
const EXIT_INTERRUPTED = 130;

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCrawlArgs(argv);

  if (!parsed.ok) {
    console.error(`crawl: ${parsed.message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }

  const options = parsed.options;
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  //Postgres before anything else: it is the crawl's only hard dependency, and finding out
  //it is down after fetching 60 pages would throw away every one of them.
  if (!(await checkPgHealth())) {
    console.error(
      "crawl: cannot reach Postgres. Check DATABASE_URL in server/.env, and that " +
        "`docker compose up -d` is running.",
    );
    return EXIT_ERROR;
  }

  const store = await openFrontierStore();
  if (!store) return EXIT_ERROR;

  //`hostsFromSeeds` is what keeps this from being an open-web crawl: 1.4's `allowedHosts`
  //is optional and omitting it means *no* host restriction. It canonicalizes, so apex and
  //www are covered by one entry — the constraint 1.3 handed forward.
  const allowedHosts = [...new Set([...hostsFromSeeds(options.seeds), ...options.hosts])];
  const frontier = new Frontier(store, {
    allowedHosts,
    maxDepth: options.maxDepth,
  });

  //Before `crawl()`, which seeds the frontier itself from `options.seeds` — clearing after
  //would delete the seeds it had just added.
  if (options.fresh) {
    await frontier.clear();
    console.error("Cleared the frontier (--fresh).");
  }

  //Read *before* the crawl. Asking afterwards cannot distinguish "the frontier was already
  //full of URLs from last night" from "this run marked its own seed seen and then got
  //nowhere", so the resume hint below would fire on a --fresh run that simply found nothing
  //to fetch.
  const seenBefore = await frontier.seenCount();

  const documents = new DocumentStore(pgPool);

  //1.5 was explicit that stopping the loop is not enough: 1.1's backoff timer is
  //deliberately not unref'd, so an in-flight fetch can be parked in a sleep that only this
  //signal cuts short. The second Ctrl-C is the escape hatch for someone who does not want
  //to wait out the in-flight requests — it skips the frontier requeue, which is why the
  //message says so rather than exiting quietly.
  const controller = new AbortController();
  let interrupts = 0;

  const onSignal = () => {
    interrupts += 1;

    if (interrupts === 1) {
      console.error("\nStopping — finishing in-flight requests (Ctrl-C again to force).");
      controller.abort();
      return;
    }

    console.error("\nForced exit. Popped URLs were not returned to the frontier.");
    process.exit(EXIT_INTERRUPTED);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.error(
    `Crawling ${options.seeds.length} seed(s) — ` +
      `hosts: ${allowedHosts.join(", ")} · max ${options.maxPages} pages · ` +
      `depth ${options.maxDepth} · concurrency ${options.concurrency} · ` +
      `frontier: ${redisClient ? "redis" : "memory"}\n`,
  );

  let processed = 0;
  const width = String(options.maxPages).length;
  const counter = () => `[${String(++processed).padStart(width)}/${options.maxPages}]`;

  try {
    const summary = await crawl({
      frontier,
      seeds: options.seeds,
      maxPages: options.maxPages,
      concurrency: options.concurrency,
      defaultCrawlDelayMs: options.defaultCrawlDelayMs,
      signal: controller.signal,

      onPage: async (crawled: CrawledPage) => {
        const outcome = await documents.storePage(crawled);
        const label = outcome.stored ? outcome.action : outcome.reason;

        console.error(
          `${counter()} ${crawled.status} ${label.padEnd(9)} ${crawled.page.url} ` +
            `(${crawled.page.links.length} links on page)`,
        );
      },

      onFailure: async (failure: CrawlFailure) => {
        await documents.recordFailure(failure);
        console.error(`${counter()} --- ${failure.reason.padEnd(9)} ${failure.url}`);
      },

      //A throw here is a bug, not a crawl outcome, so it is reported loudly and the crawl
      //keeps going — one page that blew up should not cost the other ninety-nine.
      onError: (error: unknown, url: string) => {
        console.error(`crawl: unexpected error on ${url}:`, error);
      },
    });

    console.log(await formatSummary(summary, documents.stats, frontier, seenBefore));

    return summary.stoppedBecause === "aborted" ? EXIT_INTERRUPTED : EXIT_OK;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    //In a finally so a thrown crawl still releases the pool and the Redis socket; without
    //this the process would hang on an open handle instead of reporting the failure.
    await closePg();
    await closeRedis();
  }
}

/**
 * Redis is optional, and which store we get silently decides whether a crawl resumes: the
 * Redis frontier survives the process, the memory one does not.
 *
 * A configured-but-unreachable Redis is therefore a hard failure rather than a quiet
 * fallback to memory. This is the opposite of 1.2's policy for the robots cache, and
 * deliberately so — there Redis is a cache and losing it costs politeness, here it is the
 * crawl's memory, and falling back would re-fetch everything while a stale seen-set sat in
 * Redis waiting to confuse the next run.
 */
async function openFrontierStore(): Promise<FrontierStore | null> {
  if (!redisClient) {
    console.error("REDIS_URL not set — using an in-memory frontier (this run cannot resume).");
    return new MemoryFrontierStore();
  }

  try {
    await connectRedis();
  } catch (error) {
    console.error(
      `crawl: REDIS_URL is set but Redis is unreachable (${
        error instanceof Error ? error.message : String(error)
      }).\n` +
        "       Start it with `docker compose up -d`, or unset REDIS_URL to run with an\n" +
        "       in-memory frontier that will not persist between runs.",
    );
    return null;
  }

  return new RedisFrontierStore(redisClient);
}

async function formatSummary(
  summary: CrawlSummary,
  documents: DocumentStoreStats,
  frontier: Frontier,
  seenBefore: number,
): Promise<string> {
  const failures = Object.entries(summary.failuresByReason)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`);

  const lines = [
    "",
    `Crawl stopped: ${summary.stoppedBecause} after ${(summary.elapsedMs / 1000).toFixed(1)}s`,
    "",
    section("Pages", [
      ["fetched", summary.fetched],
      ["delivered", summary.delivered],
      ["gave up", summary.gaveUp],
      ["robots blocked", summary.robotsBlocked],
      ["parse failed", summary.parseFailed],
      //"queued", not "found": `linksDiscovered` counts links the frontier *accepted*, so
      //it reads against the frontier's rejection counters below rather than against the
      //raw per-page link counts on the progress lines.
      ["links queued", summary.linksDiscovered],
      ["retries queued", summary.requeued],
      //Non-zero only after a Ctrl-C: the popped-but-unfetched buffer handed back so those
      //URLs aren't lost from the crawl for good. Worth seeing on an interrupted run.
      ["returned on stop", summary.returnedToFrontier],
      ["unexpected errors", summary.errors],
    ]),
    section("Documents", [
      ["inserted", documents.inserted],
      ["updated", documents.updated],
      ["duplicate", documents.duplicate],
      ["noindex", documents.noindex],
      ["empty", documents.empty],
      ["errors logged", documents.failuresRecorded],
    ]),
    section("Frontier", [
      ["enqueued", frontier.stats.enqueued],
      ["requeued", frontier.stats.requeued],
      ["duplicate", frontier.stats.duplicate],
      ["out of scope", frontier.stats.outOfScope],
      ["too deep", frontier.stats.tooDeep],
      ["queue full", frontier.stats.queueFull],
      ["invalid url", frontier.stats.invalidUrl],
      ["excluded", frontier.stats.excluded],
      ["still queued", await frontier.size()],
      ["seen total", await frontier.seenCount()],
    ]),
  ];

  if (failures.length > 0) lines.push(`Failures: ${failures.join(" · ")}`, "");

  //The confusing case, made self-explaining. With a Redis frontier a repeat of the same
  //command legitimately does nothing — every seed is already in `frontier:seen` — and
  //"fetched 0" alone reads as a broken crawler rather than as resume working correctly.
  if (summary.fetched === 0 && summary.stoppedBecause === "drained" && seenBefore > 0) {
    lines.push(
      `Nothing to do: the frontier already held ${seenBefore.toLocaleString("en-US")} seen ` +
        "URL(s) before this run.",
      "Pass --fresh to start over. Stored documents are not affected.",
      "",
    );
  }

  return lines.join("\n");
}

function section(title: string, rows: readonly (readonly [string, number])[]): string {
  const width = Math.max(...rows.map(([label]) => label.length));

  const body = rows
    .map(([label, value]) => `  ${label.padEnd(width)}  ${value.toLocaleString("en-US")}`)
    .join("\n");

  return `${title}\n${body}\n`;
}

//Progress goes to stderr and the summary to stdout, so `npm run crawl > report.txt` leaves
//a clean artifact while you still watch the crawl move. A hundred pages at one request per
//second per host runs for minutes, and silence for minutes is indistinguishable from a hang.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("crawl: failed —", error);
    process.exitCode = EXIT_ERROR;
  });
