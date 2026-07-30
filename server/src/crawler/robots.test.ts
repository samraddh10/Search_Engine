import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRobots, clearRobotsCache } from "./robots.js";

const servers: Server[] = [];

//beforeEach clears the robots cache.
beforeEach(() => {
  clearRobotsCache();
});

//afterEach tears down every server the test started. servers.splice(0) empties the array and returns everything that was in it,
afterEach(async () => {
  //vi.unstubAllEnvs() undoes any vi.stubEnv(...)
  vi.unstubAllEnvs();
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

interface Fixture {
  origin: string;
  hits: () => number;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Fixture> {
  let hits = 0;

  const server = createServer((req, res) => {
    if (req.url === "/robots.txt") hits += 1;
    handler(req, res);
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return { origin: `http://127.0.0.1:${port}`, hits: () => hits };
}

//serveRobots — the main test-server builder
//it builds a server that:
//Returns the robots.txt body with a chosen status/content-type when /robots.txt is requested.
function serveRobots(
  body: string,
  init: { status?: number; contentType?: string | null } = {},
): Promise<Fixture> {
  const { status = 200, contentType = "text/plain" } = init;

  return startServer((req, res) => {
    if (req.url !== "/robots.txt") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
      return;
    }

    res.writeHead(status, contentType === null ? {} : { "content-type": contentType });
    res.end(body);
  });
}

//sleep
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//Allow / disallow decisions
describe("checkRobots — allow and disallow decisions", () => {
  it("allows a path a permissive robots.txt does not restrict", async () => {
    const { origin } = await serveRobots("User-agent: *\nDisallow:\n");

    const decision = await checkRobots(`${origin}/articles/hello`);

    expect(decision.allowed).toBe(true);
    expect(decision.outcome).toBe("rules");
    expect(decision.source).toBe("network");
  });

  it("blocks a disallowed path while still allowing its siblings", async () => {
    const { origin } = await serveRobots("User-agent: *\nDisallow: /admin/\n");

    await expect(checkRobots(`${origin}/admin/secret`)).resolves.toMatchObject({
      allowed: false,
      outcome: "rules",
    });
    await expect(checkRobots(`${origin}/public/page`)).resolves.toMatchObject({
      allowed: true,
      source: "memory",
    });
  });

  it("obeys our own User-agent group in preference to the wildcard group", async () => {
    const { origin } = await serveRobots(
      [
        "User-agent: *",
        "Disallow: /",
        "",
        "User-agent: SearchEngine2Bot",
        "Disallow: /private/",
        "",
      ].join("\n"),
    );

    await expect(checkRobots(`${origin}/public/page`)).resolves.toMatchObject({ allowed: true });
    await expect(checkRobots(`${origin}/private/page`)).resolves.toMatchObject({ allowed: false });
  });

  it("honours wildcard patterns", async () => {
    const { origin } = await serveRobots("User-agent: *\nDisallow: /*.pdf$\n");

    await expect(checkRobots(`${origin}/docs/manual.pdf`)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(checkRobots(`${origin}/docs/manual.html`)).resolves.toMatchObject({
      allowed: true,
    });
  });
});

describe("checkRobots — when robots.txt is missing or unusable", () => {
  it("treats a 404 as \"no rules exist\" and allows the host", async () => {
    const { origin } = await serveRobots("not found", { status: 404, contentType: "text/plain" });

    const decision = await checkRobots(`${origin}/anything`);

    expect(decision.allowed).toBe(true);
    expect(decision.outcome).toBe("allow-all");
  });

  it("treats a 500 as unreachable and blocks the host", async () => {
    const { origin } = await serveRobots("boom", { status: 500, contentType: "text/plain" });

    const decision = await checkRobots(`${origin}/anything`, { maxAttempts: 1 });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe("disallow-all");
  });

  it("treats an HTML response as no rules rather than parsing the markup", async () => {
    const { origin } = await serveRobots("<html><body>Not found</body></html>", {
      contentType: "text/html",
    });

    await expect(checkRobots(`${origin}/anything`)).resolves.toMatchObject({
      allowed: true,
      outcome: "allow-all",
    });
  });

  it("parses a robots.txt served with no Content-Type header", async () => {
    const { origin } = await serveRobots("User-agent: *\nDisallow: /admin/\n", {
      contentType: null,
    });

    await expect(checkRobots(`${origin}/admin/x`)).resolves.toMatchObject({
      allowed: false,
      outcome: "rules",
    });
  });

  it("parses text/plain with a charset parameter", async () => {
    const { origin } = await serveRobots("User-agent: *\nDisallow: /admin/\n", {
      contentType: "text/plain; charset=utf-8",
    });

    await expect(checkRobots(`${origin}/admin/x`)).resolves.toMatchObject({ outcome: "rules" });
  });

  it("blocks the host when the connection is refused", async () => {
    const decision = await checkRobots("http://127.0.0.1:1/page", { maxAttempts: 1 });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe("disallow-all");
  });

  it("blocks the host when robots.txt times out", async () => {
    const { origin } = await startServer(() => {});

    const decision = await checkRobots(`${origin}/page`, { timeoutMs: 50, maxAttempts: 1 });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe("disallow-all");
  });

  it("blocks the host when robots.txt exceeds the size cap", async () => {
    const { origin } = await serveRobots("User-agent: *\nDisallow: /\n".repeat(200));

    const decision = await checkRobots(`${origin}/page`, { maxBytes: 64 });

    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe("disallow-all");
  });
});

describe("checkRobots — Crawl-delay", () => {
  it("reports Crawl-delay in milliseconds", async () => {
    const { origin } = await serveRobots("User-agent: *\nCrawl-delay: 2\n");

    await expect(checkRobots(`${origin}/page`)).resolves.toMatchObject({ crawlDelayMs: 2_000 });
  });

  it("caps an absurd Crawl-delay instead of parking the crawl", async () => {
    const { origin } = await serveRobots("User-agent: *\nCrawl-delay: 3600\n");

    const decision = await checkRobots(`${origin}/page`);

    expect(decision.crawlDelayMs).toBe(30_000);
  });

  it("leaves crawlDelayMs undefined when the site names no Crawl-delay", async () => {
    const { origin } = await serveRobots("User-agent: *\nDisallow: /admin/\n");

    const decision = await checkRobots(`${origin}/page`);

    expect(decision.crawlDelayMs).toBeUndefined();
  });

  it("keeps an explicit Crawl-delay of 0 distinct from an absent one", async () => {
    const { origin } = await serveRobots("User-agent: *\nCrawl-delay: 0\n");

    const decision = await checkRobots(`${origin}/page`);

    expect(decision.crawlDelayMs).toBe(0);
  });
});

describe("checkRobots — sitemaps", () => {
  it("surfaces Sitemap URLs without fetching them", async () => {
    const { origin, hits } = await serveRobots(
      [
        "User-agent: *",
        "Disallow:",
        "Sitemap: https://example.com/sitemap.xml",
        "Sitemap: https://example.com/news-sitemap.xml",
        "",
      ].join("\n"),
    );

    const decision = await checkRobots(`${origin}/page`);

    expect(decision.sitemaps).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/news-sitemap.xml",
    ]);
    expect(hits()).toBe(1);
  });

  it("reports an empty sitemap list when the file names none", async () => {
    const { origin } = await serveRobots("User-agent: *\nDisallow:\n");

    await expect(checkRobots(`${origin}/page`)).resolves.toMatchObject({ sitemaps: [] });
  });
});

describe("checkRobots — caching", () => {
  it("fetches robots.txt once per host, however many URLs are checked", async () => {
    const { origin, hits } = await serveRobots("User-agent: *\nDisallow: /admin/\n");

    for (let i = 0; i < 5; i += 1) {
      await checkRobots(`${origin}/page/${i}`);
    }

    expect(hits()).toBe(1);
  });

  it("collapses concurrent checks for one host into a single fetch", async () => {
    const { origin, hits } = await serveRobots("User-agent: *\nDisallow: /admin/\n");

    const decisions = await Promise.all([
      checkRobots(`${origin}/a`),
      checkRobots(`${origin}/b`),
      checkRobots(`${origin}/admin/c`),
    ]);

    expect(hits()).toBe(1);
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, false]);
  });

  it("caches the absence of a robots.txt instead of re-asking per URL", async () => {
    const { origin, hits } = await serveRobots("nope", { status: 404 });

    await checkRobots(`${origin}/a`);
    const second = await checkRobots(`${origin}/b`);

    expect(hits()).toBe(1);
    expect(second.source).toBe("memory");
    expect(second.allowed).toBe(true);
  });

  it("caches an unreachable robots.txt rather than retrying per URL", async () => {
    const { origin, hits } = await serveRobots("boom", { status: 500 });

    await checkRobots(`${origin}/a`, { maxAttempts: 1 });
    const second = await checkRobots(`${origin}/b`, { maxAttempts: 1 });

    expect(hits()).toBe(1);
    expect(second.source).toBe("memory");
    expect(second.allowed).toBe(false);
  });

  it("re-fetches once the cached entry has expired", async () => {
    const { origin, hits } = await serveRobots("User-agent: *\nDisallow: /admin/\n");

    await checkRobots(`${origin}/a`, { rulesTtlMs: 5 });
    await sleep(20);
    await checkRobots(`${origin}/b`, { rulesTtlMs: 5 });

    expect(hits()).toBe(2);
  });

  it("keeps separate cache entries per origin", async () => {
    const strict = await serveRobots("User-agent: *\nDisallow: /\n");
    const open = await serveRobots("User-agent: *\nDisallow:\n");

    await expect(checkRobots(`${strict.origin}/page`)).resolves.toMatchObject({ allowed: false });
    await expect(checkRobots(`${open.origin}/page`)).resolves.toMatchObject({ allowed: true });

    expect(strict.hits()).toBe(1);
    expect(open.hits()).toBe(1);
  });
});

describe("checkRobots — cancellation and bad input", () => {
  it("blocks on abort without caching the non-answer", async () => {
    const { origin, hits } = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /admin/\n");
      }, 60);
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const aborted = await checkRobots(`${origin}/page`, { signal: controller.signal });

    expect(aborted.allowed).toBe(false);
    expect(aborted.outcome).toBe("disallow-all");

    const later = await checkRobots(`${origin}/page`);
    expect(later.outcome).toBe("rules");
    expect(later.allowed).toBe(true);
    expect(later.source).toBe("network");
    expect(hits()).toBe(2);
  });

  it("refuses a URL that is not absolute http(s)", async () => {
    await expect(checkRobots("ftp://example.com/file")).resolves.toMatchObject({ allowed: false });
    await expect(checkRobots("not a url")).resolves.toMatchObject({ allowed: false });
  });
});

describe("checkRobots — the Redis layer", () => {
  it("hydrates from Redis after the in-process cache is gone", async () => {
    const { origin, hits } = await serveRobots("User-agent: *\nDisallow: /admin/\n");

    vi.resetModules();
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const robots = await import("./robots.js");
    const { closeRedis } = await import("../db/redis.js");

    try {
      const opts = { rulesTtlMs: 5_000 };

      const first = await robots.checkRobots(`${origin}/admin/x`, opts);
      expect(first.source).toBe("network");
      expect(first.allowed).toBe(false);

      robots.clearRobotsCache();

      const second = await robots.checkRobots(`${origin}/admin/y`, opts);
      expect(second.source).toBe("redis");
      expect(second.allowed).toBe(false);
      expect((await robots.checkRobots(`${origin}/public`, opts)).allowed).toBe(true);

      expect(hits()).toBe(1);
    } finally {
      await closeRedis();
    }
  });
});
