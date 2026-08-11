import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frontier, hostsFromSeeds } from "./frontier.js";
import { MemoryFrontierStore } from "./frontierStore.js";
import { clearRobotsCache } from "./robots.js";
import {
  crawl,
  type CrawledPage,
  type CrawlFailure,
  type CrawlOptions,
  type CrawlSummary,
} from "./scheduler.js";

const servers: Server[] = [];

beforeEach(() => {
  clearRobotsCache();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

interface Reply {
  status?: number;
  contentType?: string | null;
  body?: string;
  headers?: Record<string, string>;
}

type Route = Reply | ((hit: number) => Reply);

interface Site {
  origin: string;
  hits: (path: string) => number;
}

//A real HTTP server rather than a mocked fetch, matching 1.1–1.3: a mock would only assert
//our own assumptions about the transport back at us.
async function startSite(routes: Record<string, Route>): Promise<Site> {
  const hits = new Map<string, number>();

  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);

    const route = routes[path];
    if (!route) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>not found</body></html>");
      return;
    }

    const reply = typeof route === "function" ? route(count) : route;
    const { status = 200, contentType = "text/html", body = "", headers = {} } = reply;

    res.writeHead(status, {
      ...(contentType === null ? {} : { "content-type": contentType }),
      ...headers,
    });
    res.end(body);
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return { origin: `http://127.0.0.1:${port}`, hits: (path) => hits.get(path) ?? 0 };
}

function page(...links: string[]): Reply {
  const anchors = links.map((href) => `<a href="${href}">link</a>`).join("");
  return { body: `<html><body><p>Some indexable words here.</p>${anchors}</body></html>` };
}

function robots(body: string): Reply {
  return { contentType: "text/plain", body };
}

interface Run {
  summary: CrawlSummary;
  frontier: Frontier;
  delivered: CrawledPage[];
}

async function run(
  site: Site,
  overrides: Partial<CrawlOptions> & { seedPaths?: string[] } = {},
): Promise<Run> {
  const { seedPaths = ["/"], ...options } = overrides;
  const seeds = seedPaths.map((path) => `${site.origin}${path}`);

  const frontier =
    options.frontier ??
    new Frontier(new MemoryFrontierStore(), { allowedHosts: hostsFromSeeds(seeds) });

  const delivered: CrawledPage[] = [];

  const summary = await crawl({
    seeds,
    //Every fixture server is 127.0.0.1, so they all share one politeness bucket. A real delay
    //would serialize the whole suite behind it.
    defaultCrawlDelayMs: 0,
    concurrency: 2,
    //Let the scheduler's own requeue policy be what's under test, rather than the fetcher's
    //internal retry loop.
    fetchOptions: { maxAttempts: 1, baseBackoffMs: 0 },
    ...options,
    frontier,
    onPage: async (crawled) => {
      delivered.push(crawled);
      await options.onPage?.(crawled);
    },
  });

  return { summary, frontier, delivered };
}

describe("crawl — traversal", () => {
  it("follows links out from the seed and delivers every page once", async () => {
    const site = await startSite({
      "/": page("/a", "/b"),
      "/a": page("/c"),
      "/b": page("/a"),
      "/c": page(),
    });

    const { summary, delivered } = await run(site);

    expect(summary.stoppedBecause).toBe("drained");
    expect(summary.fetched).toBe(4);
    expect(summary.delivered).toBe(4);
    expect(delivered.map((d) => d.url).sort()).toEqual(
      ["/", "/a", "/b", "/c"].map((path) => `${site.origin}${path}`),
    );
    //A page reachable two ways is still fetched once.
    expect(site.hits("/a")).toBe(1);
  });

  it("hands each page its depth and fetch metadata", async () => {
    const site = await startSite({ "/": page("/a"), "/a": page() });

    const { delivered } = await run(site);
    const root = delivered.find((d) => d.url === `${site.origin}/`);
    const child = delivered.find((d) => d.url === `${site.origin}/a`);

    expect(root).toMatchObject({ depth: 0, status: 200, contentType: "text/html" });
    expect(child?.depth).toBe(1);
    expect(root?.page.text).toContain("Some indexable words");
    expect(root?.bytes).toBeGreaterThan(0);
    expect(root?.fetchedAt).toBeInstanceOf(Date);
  });

  it("stops descending past the frontier's maxDepth", async () => {
    const site = await startSite({
      "/": page("/a"),
      "/a": page("/b"),
      "/b": page("/c"),
      "/c": page(),
    });
    const seeds = [`${site.origin}/`];
    const frontier = new Frontier(new MemoryFrontierStore(), {
      allowedHosts: hostsFromSeeds(seeds),
      maxDepth: 1,
    });

    const { summary } = await run(site, { frontier });

    expect(summary.fetched).toBe(2);
    expect(summary.frontier.tooDeep).toBe(1);
    expect(site.hits("/b")).toBe(0);
  });

  it("counts out-of-scope links without fetching them", async () => {
    const site = await startSite({ "/": page("/a", "https://example.org/elsewhere"), "/a": page() });

    const { summary } = await run(site);

    expect(summary.fetched).toBe(2);
    expect(summary.frontier.outOfScope).toBe(1);
  });
});

describe("crawl — robots", () => {
  it("skips a disallowed path and counts it", async () => {
    const site = await startSite({
      "/robots.txt": robots("User-agent: *\nDisallow: /private\n"),
      "/": page("/public", "/private"),
      "/public": page(),
      "/private": page(),
    });

    const { summary } = await run(site);

    expect(summary.robotsBlocked).toBe(1);
    expect(summary.fetched).toBe(2);
    expect(site.hits("/private")).toBe(0);
  });

  it("never enqueues robots.txt itself", async () => {
    const site = await startSite({
      "/robots.txt": robots("User-agent: *\nDisallow:\n"),
      "/": page("/robots.txt", "/a"),
      "/a": page(),
    });

    const { summary } = await run(site);

    expect(summary.frontier.excluded).toBe(1);
    //Once for the robots check, never as a page.
    expect(site.hits("/robots.txt")).toBe(1);
  });
});

describe("crawl — redirects", () => {
  it("marks the post-redirect URL seen, so the final spelling is never re-queued", async () => {
    const site = await startSite({
      "/": page("/old"),
      "/old": { status: 301, headers: { location: "/new" }, body: "" },
      "/new": page(),
    });

    const { summary, frontier, delivered } = await run(site);

    expect(summary.fetched).toBe(2);
    expect(delivered.map((d) => d.url)).toContain(`${site.origin}/new`);
    //The constraint 1.3 handed forward: without this, every link spelled /new re-enters the
    //queue, re-fetches, eats the redirect and lands on a page we already have.
    expect(await frontier.hasSeen(`${site.origin}/new`)).toBe(true);
    expect(await frontier.add(`${site.origin}/new`, { depth: 1 })).toMatchObject({
      reason: "duplicate",
    });
    //requestedUrl and url stay distinct, so 1.6 can tell where it asked from where it landed.
    const redirected = delivered.find((d) => d.url === `${site.origin}/new`);
    expect(redirected?.requestedUrl).toBe(`${site.origin}/old`);
  });
});

describe("crawl — failures and retries", () => {
  it("requeues a retryable failure and succeeds on the next round", async () => {
    const site = await startSite({
      "/": page("/flaky"),
      "/flaky": (hit) => (hit === 1 ? { status: 503, body: "" } : page()),
    });

    const { summary } = await run(site);

    expect(summary.requeued).toBe(1);
    expect(summary.fetched).toBe(2);
    expect(summary.failed).toBe(0);
    expect(site.hits("/flaky")).toBe(2);
  });

  it("gives up after maxRequeues instead of cycling forever", async () => {
    const site = await startSite({ "/": page("/broken"), "/broken": { status: 503, body: "" } });

    const { summary } = await run(site, { maxRequeues: 2 });

    expect(summary.requeued).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.gaveUp).toBe(1);
    expect(summary.failuresByReason["http-error"]).toBe(1);
    //Three scheduling rounds: the original plus two requeues.
    expect(site.hits("/broken")).toBe(3);
  });

  it("does not requeue a non-retryable failure", async () => {
    const site = await startSite({ "/": page("/missing") });

    const { summary } = await run(site);

    expect(summary.requeued).toBe(0);
    expect(summary.gaveUp).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.failuresByReason["http-error"]).toBe(1);
    expect(site.hits("/missing")).toBe(1);
  });

  it("puts a Retry-After on the whole host, not just the URL that earned it", async () => {
    const site = await startSite({
      "/": page("/slowdown", "/sibling"),
      "/slowdown": (hit) =>
        hit === 1 ? { status: 503, body: "", headers: { "retry-after": "1" } } : page(),
      "/sibling": page(),
    });

    const startedAt = Date.now();
    const { summary } = await run(site, { concurrency: 4 });
    const elapsed = Date.now() - startedAt;

    expect(summary.requeued).toBe(1);
    expect(summary.fetched).toBe(3);
    //A 503 saying "wait a second" must hold back /sibling too — hitting a different URL on a
    //host that just asked for a second is exactly as rude as retrying the same one.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(site.hits("/sibling")).toBe(1);
  });

  it("survives a throwing onPage and reports it", async () => {
    const site = await startSite({ "/": page("/a"), "/a": page() });
    const seen: string[] = [];

    const { summary } = await run(site, {
      onPage: (crawled) => {
        seen.push(crawled.url);
        throw new Error("sink exploded");
      },
      onError: () => {},
    });

    expect(summary.errors).toBe(2);
    expect(seen).toHaveLength(2);
    expect(summary.stoppedBecause).toBe("drained");
  });
});

//onFailure is what 1.6 persists into crawl_errors, so what it does *not* report matters as
//much as what it does: a row per robots-blocked URL on a disallow-all host would bury the
//real failures, and a row for a URL that later succeeded would be a lie.
describe("crawl — failure reporting", () => {
  it("reports a non-retryable failure once, with its status", async () => {
    const site = await startSite({ "/": page("/missing") });
    const failures: CrawlFailure[] = [];

    await run(site, { onFailure: (failure) => void failures.push(failure) });

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      url: `${site.origin}/missing`,
      depth: 1,
      reason: "http-error",
      status: 404,
      retryable: false,
      rounds: 1,
    });
  });

  it("reports a retryable failure only after the requeues are spent", async () => {
    const site = await startSite({ "/": page("/broken"), "/broken": { status: 503, body: "" } });
    const failures: CrawlFailure[] = [];

    await run(site, { maxRequeues: 2, onFailure: (failure) => void failures.push(failure) });

    expect(failures).toHaveLength(1);
    //One report, but three dispatches — the count 1.6 writes to crawl_errors.attempts.
    expect(failures[0]).toMatchObject({ reason: "http-error", retryable: true, rounds: 3 });
  });

  it("says nothing about a URL that succeeded on a later round", async () => {
    const site = await startSite({
      "/": page("/flaky"),
      "/flaky": (hit) => (hit === 1 ? { status: 503, body: "" } : page()),
    });
    const failures: CrawlFailure[] = [];

    const { summary } = await run(site, { onFailure: (failure) => void failures.push(failure) });

    expect(summary.requeued).toBe(1);
    expect(failures).toEqual([]);
  });

  it("says nothing about a robots-blocked URL", async () => {
    const site = await startSite({
      "/robots.txt": robots("User-agent: *\nDisallow: /private"),
      "/": page("/private", "/public"),
      "/private": page(),
      "/public": page(),
    });
    const failures: CrawlFailure[] = [];

    const { summary } = await run(site, { onFailure: (failure) => void failures.push(failure) });

    expect(summary.robotsBlocked).toBe(1);
    expect(failures).toEqual([]);
  });

  it("reports a page whose final URL cannot be parsed", async () => {
    //The one way parseHtml refuses a page the fetcher accepted. Every character below is
    //legal in a URL and costs one byte on the wire, but form-urlencoding re-encodes each to
    //%21 — so this is comfortably under MAX_URL_LENGTH when the fetcher checks it and over
    //the cap once normalizeUrl rebuilds the query. The frontier never saw it either: it
    //arrived as a redirect target, not as a link.
    const overlong = `/deep?q=${"!".repeat(900)}`;
    const site = await startSite({
      "/": page("/redirect"),
      "/redirect": { status: 302, headers: { location: overlong }, body: "" },
      [overlong]: page(),
    });
    const failures: CrawlFailure[] = [];

    const { summary } = await run(site, { onFailure: (failure) => void failures.push(failure) });

    expect(summary.parseFailed).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: "parse-failed", status: 200, retryable: false });
  });

  it("says nothing when the crawl is aborted mid-flight", async () => {
    const site = await startSite({ "/": page("/a"), "/a": page() });
    const controller = new AbortController();
    const failures: CrawlFailure[] = [];

    const { summary } = await run(site, {
      signal: controller.signal,
      onPage: () => controller.abort(),
      onFailure: (failure) => void failures.push(failure),
    });

    expect(summary.stoppedBecause).toBe("aborted");
    //Our own Ctrl-C is not evidence about the host, so nothing is recorded against it.
    expect(failures).toEqual([]);
  });
});

describe("crawl — stop conditions", () => {
  it("stops dispatching at maxPages", async () => {
    const site = await startSite({
      "/": page("/a", "/b", "/c"),
      "/a": page(),
      "/b": page(),
      "/c": page(),
    });

    const { summary, frontier } = await run(site, { concurrency: 1, maxPages: 2 });

    expect(summary.stoppedBecause).toBe("max-pages");
    expect(summary.fetched).toBe(2);
    //Popped-but-unprocessed URLs are already marked seen, so they must go back or they leave
    //the crawl for good.
    expect(summary.returnedToFrontier).toBeGreaterThan(0);
    expect(await frontier.size()).toBeGreaterThan(0);
  });

  it("returns the popped buffer to the frontier on abort", async () => {
    const site = await startSite({
      "/": page("/a", "/b", "/c"),
      "/a": page(),
      "/b": page(),
      "/c": page(),
    });
    const controller = new AbortController();

    const { summary, frontier } = await run(site, {
      concurrency: 1,
      signal: controller.signal,
      onPage: () => controller.abort(),
    });

    expect(summary.stoppedBecause).toBe("aborted");
    expect(summary.fetched).toBe(1);
    expect(await frontier.size()).toBe(3);
  });

  it("reports drained with an accurate summary when the site runs out", async () => {
    //1.3 already dedups links within a page, so the repeat has to come from a second page for
    //the frontier to be the one rejecting it.
    const site = await startSite({ "/": page("/a", "/b"), "/a": page(), "/b": page("/a") });

    const { summary } = await run(site);

    expect(summary).toMatchObject({
      stoppedBecause: "drained",
      fetched: 3,
      delivered: 3,
      failed: 0,
      requeued: 0,
      returnedToFrontier: 0,
      errors: 0,
      linksDiscovered: 2,
    });
    expect(summary.frontier.duplicate).toBe(1);
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
