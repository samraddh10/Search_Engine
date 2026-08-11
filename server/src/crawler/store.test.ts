import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePg, pgPool } from "../db/pg.js";
import type { ParsedPage } from "./parser.js";
import type { CrawledPage, CrawlFailure } from "./scheduler.js";
import { contentHash, DocumentStore } from "./store.js";

// Real Postgres, real DDL — the same choice 0.5 made for the test-DB strategy. The bugs
// worth catching here are in SQL (the duplicate guard, ON CONFLICT, xmax), and a mocked
// client would only assert our own beliefs about that SQL back at us.
afterAll(closePg);

beforeEach(async () => {
  // CASCADE reaches postings, which references documents. Nothing else in the suite holds
  // rows in these tables, and fileParallelism is off, so this cannot race another file.
  await pgPool.query("TRUNCATE documents, crawl_errors RESTART IDENTITY CASCADE");
});

interface DocumentRow {
  id: number;
  url: string;
  title: string;
  content_text: string;
  content_hash: string;
  http_status: number;
  fetched_at: Date;
  token_count: number;
  lang: string | null;
  canonical_url: string | null;
}

interface ErrorRow {
  url: string;
  reason: string;
  http_status: number | null;
  detail: string | null;
  depth: number;
  attempts: number;
  first_seen_at: Date;
  last_seen_at: Date;
}

async function documents(): Promise<DocumentRow[]> {
  const { rows } = await pgPool.query<DocumentRow>("SELECT * FROM documents ORDER BY id");
  return rows;
}

async function crawlErrors(): Promise<ErrorRow[]> {
  const { rows } = await pgPool.query<ErrorRow>("SELECT * FROM crawl_errors ORDER BY url");
  return rows;
}

function parsedPage(overrides: Partial<ParsedPage> = {}): ParsedPage {
  return {
    url: "https://example.test/page",
    canonicalUrl: null,
    title: "Example page",
    text: "Some indexable prose about crawling.",
    lang: "en",
    description: null,
    links: [],
    noindex: false,
    nofollow: false,
    ...overrides,
  };
}

function crawledPage(
  page: Partial<ParsedPage> = {},
  overrides: Partial<Omit<CrawledPage, "page">> = {},
): CrawledPage {
  const parsed = parsedPage(page);

  return {
    page: parsed,
    depth: 1,
    requestedUrl: parsed.url,
    url: parsed.url,
    status: 200,
    contentType: "text/html",
    charset: "utf-8",
    bytes: 1024,
    fetchedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function crawlFailure(overrides: Partial<CrawlFailure> = {}): CrawlFailure {
  return {
    url: "https://example.test/broken",
    depth: 2,
    reason: "http-error",
    status: 500,
    detail: "HTTP 500",
    retryable: true,
    rounds: 1,
    ...overrides,
  };
}

describe("contentHash", () => {
  it("is stable for identical input and differs on any change", () => {
    expect(contentHash("Title", "Body")).toBe(contentHash("Title", "Body"));
    expect(contentHash("Title", "Body")).not.toBe(contentHash("Title", "Body!"));
    expect(contentHash("Title", "Body")).not.toBe(contentHash("Titl", "Body"));
  });

  // Without a separator, hashing title+text concatenated would make these two collide, and
  // one of the two documents would be silently dropped as a duplicate.
  it("keeps the title and text fields distinct", () => {
    expect(contentHash("a\nb", "")).not.toBe(contentHash("a", "b"));
  });
});

describe("DocumentStore.storePage", () => {
  it("inserts a new document with the crawled metadata", async () => {
    const store = new DocumentStore(pgPool);

    const result = await store.storePage(
      crawledPage({
        url: "https://example.test/docs",
        title: "Docs",
        text: "  Text about indexing.  ",
        lang: "pt-br",
        canonicalUrl: "https://example.test/docs",
      }),
    );

    expect(result).toMatchObject({ stored: true, action: "inserted" });

    const [row] = await documents();
    expect(row).toMatchObject({
      url: "https://example.test/docs",
      title: "Docs",
      // Stored trimmed: the leading whitespace would otherwise shift every position 3.2
      // slices snippets from.
      content_text: "Text about indexing.",
      content_hash: contentHash("Docs", "Text about indexing."),
      http_status: 200,
      lang: "pt-br",
      canonical_url: "https://example.test/docs",
      // Phase 2 owns this column; 1.6 must not guess at it.
      token_count: 0,
    });
    expect(row!.fetched_at).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  // The parser normalizes; the fetcher does not. Storing the raw final URL would let a
  // re-crawl insert a sibling row for a page the frontier already considers seen.
  it("stores the parser's normalized URL, not the fetcher's raw one", async () => {
    const store = new DocumentStore(pgPool);

    await store.storePage(
      crawledPage(
        { url: "https://example.test/a" },
        { requestedUrl: "https://example.test/start", url: "https://example.test/a?utm_source=x" },
      ),
    );

    expect((await documents())[0]!.url).toBe("https://example.test/a");
  });

  it("updates in place when the same URL is crawled again", async () => {
    const store = new DocumentStore(pgPool);

    await store.storePage(crawledPage({ title: "First", text: "Original body." }));
    const second = await store.storePage(
      crawledPage(
        { title: "Second", text: "Rewritten body." },
        { status: 203, fetchedAt: new Date("2026-02-02T00:00:00Z") },
      ),
    );

    expect(second).toMatchObject({ stored: true, action: "updated" });

    const rows = await documents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Second",
      content_text: "Rewritten body.",
      http_status: 203,
    });
    expect(rows[0]!.fetched_at).toEqual(new Date("2026-02-02T00:00:00Z"));
  });

  it("resets token_count when the content changed, so Phase 2 reindexes it", async () => {
    const store = new DocumentStore(pgPool);
    await store.storePage(crawledPage({ text: "Original body." }));
    await pgPool.query("UPDATE documents SET token_count = 42");

    await store.storePage(crawledPage({ text: "Rewritten body." }));

    expect((await documents())[0]!.token_count).toBe(0);
  });

  // The mirror image, and the more important half: a crawl that re-fetches unchanged pages
  // must not drop the whole corpus out of the index.
  it("leaves token_count alone when the content is unchanged", async () => {
    const store = new DocumentStore(pgPool);
    await store.storePage(crawledPage());
    await pgPool.query("UPDATE documents SET token_count = 42");

    await store.storePage(crawledPage({}, { fetchedAt: new Date("2026-03-03T00:00:00Z") }));

    const [row] = await documents();
    expect(row!.token_count).toBe(42);
    expect(row!.fetched_at).toEqual(new Date("2026-03-03T00:00:00Z"));
  });

  it("rejects a second URL carrying content already in the corpus", async () => {
    const store = new DocumentStore(pgPool);
    await store.storePage(crawledPage({ url: "https://example.test/a" }));

    const result = await store.storePage(crawledPage({ url: "https://example.test/b" }));

    expect(result).toEqual({
      stored: false,
      reason: "duplicate",
      url: "https://example.test/b",
    });
    expect(await documents()).toHaveLength(1);
  });

  // The duplicate guard must not lock an existing document out of its own update: a page
  // rewritten to match another page's content is still that URL's current content.
  it("still updates a known URL whose new content matches another document", async () => {
    const store = new DocumentStore(pgPool);
    await store.storePage(crawledPage({ url: "https://example.test/a", text: "Shared body." }));
    await store.storePage(crawledPage({ url: "https://example.test/b", text: "Other body." }));

    const result = await store.storePage(
      crawledPage({ url: "https://example.test/b", text: "Shared body." }),
    );

    expect(result).toMatchObject({ stored: true, action: "updated" });

    const rows = await documents();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.content_text)).toEqual(["Shared body.", "Shared body."]);
  });

  it("records rel=canonical without letting it become the document's identity", async () => {
    const store = new DocumentStore(pgPool);

    // The failure mode this guards: a template emitting the same canonical on every page.
    await store.storePage(
      crawledPage({ url: "https://example.test/one", canonicalUrl: "https://example.test/" }),
    );
    await store.storePage(
      crawledPage({
        url: "https://example.test/two",
        text: "A different body.",
        canonicalUrl: "https://example.test/",
      }),
    );

    const rows = await documents();
    expect(rows.map((row) => row.url)).toEqual([
      "https://example.test/one",
      "https://example.test/two",
    ]);
    expect(rows.every((row) => row.canonical_url === "https://example.test/")).toBe(true);
  });

  it("skips a noindex page", async () => {
    const store = new DocumentStore(pgPool);

    const result = await store.storePage(crawledPage({ noindex: true }));

    expect(result).toMatchObject({ stored: false, reason: "noindex" });
    expect(await documents()).toHaveLength(0);
  });

  it("removes a stored document that has since added noindex", async () => {
    const store = new DocumentStore(pgPool);
    await store.storePage(crawledPage());

    await store.storePage(crawledPage({ noindex: true }));

    expect(await documents()).toHaveLength(0);
  });

  it("skips a page with no text", async () => {
    const store = new DocumentStore(pgPool);

    const result = await store.storePage(crawledPage({ text: "   \n\t " }));

    expect(result).toMatchObject({ stored: false, reason: "empty" });
    expect(await documents()).toHaveLength(0);
  });

  it("honours a raised minContentChars", async () => {
    const store = new DocumentStore(pgPool, { minContentChars: 20 });

    await store.storePage(crawledPage({ text: "Too short." }));

    expect(await documents()).toHaveLength(0);
    expect(store.stats.empty).toBe(1);
  });

  it("tallies every outcome", async () => {
    const store = new DocumentStore(pgPool);

    await store.storePage(crawledPage({ url: "https://example.test/a" }));
    await store.storePage(crawledPage({ url: "https://example.test/a" }));
    await store.storePage(crawledPage({ url: "https://example.test/b" }));
    await store.storePage(crawledPage({ url: "https://example.test/c", noindex: true }));
    await store.storePage(crawledPage({ url: "https://example.test/d", text: "" }));

    expect(store.stats).toMatchObject({
      inserted: 1,
      updated: 1,
      duplicate: 1,
      noindex: 1,
      empty: 1,
    });
  });

  it("returns a copy of its stats, not the live object", async () => {
    const store = new DocumentStore(pgPool);
    const before = store.stats;

    await store.storePage(crawledPage());

    expect(before.inserted).toBe(0);
    expect(store.stats.inserted).toBe(1);
  });
});

describe("DocumentStore.recordFailure", () => {
  it("records a failed URL", async () => {
    const store = new DocumentStore(pgPool);

    await store.recordFailure(crawlFailure({ reason: "http-error", status: 503, rounds: 3 }));

    const [row] = await crawlErrors();
    expect(row).toMatchObject({
      url: "https://example.test/broken",
      reason: "http-error",
      http_status: 503,
      detail: "HTTP 500",
      depth: 2,
      attempts: 3,
    });
  });

  it("leaves http_status null for a failure that never got a response", async () => {
    const store = new DocumentStore(pgPool);

    await store.recordFailure(
      crawlFailure({ reason: "timeout", status: undefined, detail: "timed out after 10000ms" }),
    );

    expect((await crawlErrors())[0]).toMatchObject({ reason: "timeout", http_status: null });
  });

  it("accumulates attempts across runs instead of adding a second row", async () => {
    const store = new DocumentStore(pgPool);
    await store.recordFailure(crawlFailure({ reason: "timeout", status: undefined, rounds: 2 }));
    const [first] = await crawlErrors();

    await store.recordFailure(crawlFailure({ reason: "network", status: undefined, rounds: 1 }));

    const rows = await crawlErrors();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "network", attempts: 3 });
    // The row remembers when the URL first broke, but reports the latest verdict.
    expect(rows[0]!.first_seen_at).toEqual(first!.first_seen_at);
    expect(rows[0]!.last_seen_at.getTime()).toBeGreaterThanOrEqual(first!.last_seen_at.getTime());
  });

  it("keeps the shallowest depth the URL was discovered at", async () => {
    const store = new DocumentStore(pgPool);

    await store.recordFailure(crawlFailure({ depth: 3 }));
    await store.recordFailure(crawlFailure({ depth: 1 }));
    await store.recordFailure(crawlFailure({ depth: 2 }));

    expect((await crawlErrors())[0]!.depth).toBe(1);
  });

  it("truncates an unreasonably long detail", async () => {
    const store = new DocumentStore(pgPool, { maxDetailChars: 20 });

    await store.recordFailure(crawlFailure({ detail: "x".repeat(5_000) }));

    expect((await crawlErrors())[0]!.detail).toBe("x".repeat(20));
  });

  it("clears the error row once the URL is stored successfully", async () => {
    const store = new DocumentStore(pgPool);
    await store.recordFailure(crawlFailure({ url: "https://example.test/page" }));

    await store.storePage(crawledPage({ url: "https://example.test/page" }));

    expect(await crawlErrors()).toHaveLength(0);
    expect(store.stats.errorsCleared).toBe(1);
  });

  // A previous run may have recorded the pre-redirect spelling, which is the URL a re-seed
  // would use — leaving it behind would report a page we now hold as still broken.
  it("clears the error row recorded under the pre-redirect URL", async () => {
    const store = new DocumentStore(pgPool);
    await store.recordFailure(crawlFailure({ url: "https://example.test/old" }));

    await store.storePage(
      crawledPage(
        { url: "https://example.test/new" },
        { requestedUrl: "https://example.test/old", url: "https://example.test/new" },
      ),
    );

    expect(await crawlErrors()).toHaveLength(0);
  });

  it("leaves other URLs' error rows alone", async () => {
    const store = new DocumentStore(pgPool);
    await store.recordFailure(crawlFailure({ url: "https://example.test/broken" }));

    await store.storePage(crawledPage({ url: "https://example.test/page" }));

    expect((await crawlErrors()).map((row) => row.url)).toEqual(["https://example.test/broken"]);
  });
});
