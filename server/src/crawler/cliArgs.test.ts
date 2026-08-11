//Pure function, no fixture server and no database — the reason arg parsing was split out
//of cli.ts at all. What's worth pinning here is mostly the *rejections*: a flag that is
//silently ignored or coerced to NaN means a crawl that runs with limits the user thought
//they had changed, and the only symptom is a crawl that behaves oddly hours later.
import { describe, expect, it } from "vitest";
import { parseCrawlArgs } from "./cliArgs.js";
import { FRONTIER_DEFAULTS } from "./frontier.js";
import { CRAWL_DEFAULTS } from "./scheduler.js";

function options(argv: string[]) {
  const result = parseCrawlArgs(argv);
  if (!result.ok) throw new Error(`expected ok, got: ${result.message}`);

  return result.options;
}

function failure(argv: string[]): string {
  const result = parseCrawlArgs(argv);
  if (result.ok) throw new Error("expected a parse failure");

  return result.message;
}

describe("parseCrawlArgs", () => {
  it("accepts a single seed and fills every other value from the shared defaults", () => {
    const parsed = options(["--seed", "https://example.com"]);

    expect(parsed.seeds).toEqual(["https://example.com"]);
    expect(parsed.hosts).toEqual([]);
    expect(parsed.fresh).toBe(false);
    //Read from the constants rather than hard-coded, so a change to CRAWL_DEFAULTS moves
    //the CLI's documented default and this assertion together.
    expect(parsed.maxPages).toBe(CRAWL_DEFAULTS.maxPages);
    expect(parsed.concurrency).toBe(CRAWL_DEFAULTS.concurrency);
    expect(parsed.defaultCrawlDelayMs).toBe(CRAWL_DEFAULTS.defaultCrawlDelayMs);
    expect(parsed.maxDepth).toBe(FRONTIER_DEFAULTS.maxDepth);
  });

  it("collects a repeated --seed", () => {
    const parsed = options([
      "--seed",
      "https://a.example",
      "--seed",
      "https://b.example",
    ]);

    expect(parsed.seeds).toEqual(["https://a.example", "https://b.example"]);
  });

  it("reads the short forms", () => {
    const parsed = options(["-s", "https://example.com", "-m", "5", "-d", "1", "-c", "2"]);

    expect(parsed.maxPages).toBe(5);
    expect(parsed.maxDepth).toBe(1);
    expect(parsed.concurrency).toBe(2);
  });

  it("coerces numeric flags out of their string form", () => {
    const parsed = options([
      "--seed",
      "https://example.com",
      "--max",
      "250",
      "--delay",
      "0",
    ]);

    expect(parsed.maxPages).toBe(250);
    //Zero is a real value, not a missing one — 1.5 went out of its way to honour an
    //explicit `Crawl-delay: 0`, and a `?? default` here would have quietly discarded it.
    expect(parsed.defaultCrawlDelayMs).toBe(0);
  });

  it("requires at least one seed", () => {
    expect(failure([])).toMatch(/--seed is required/);
    expect(failure(["--max", "10"])).toMatch(/--seed is required/);
  });

  //The frontier would reject these as invalid-url after the crawl had already started and
  //opened its connections; catching them here means the error names the flag.
  it("rejects seeds that aren't crawlable http(s) URLs", () => {
    expect(failure(["--seed", "ftp://example.com"])).toMatch(/not a valid http\(s\) URL/);
    expect(failure(["--seed", "file:///etc/passwd"])).toMatch(/not a valid http\(s\) URL/);
    expect(failure(["--seed", "example.com"])).toMatch(/not a valid http\(s\) URL/);
    expect(failure(["--seed", "javascript:alert(1)"])).toMatch(/not a valid http\(s\) URL/);
  });

  it("rejects numeric flags that aren't numbers", () => {
    expect(failure(["--seed", "https://example.com", "--max", "abc"])).toMatch(/--max/);
    expect(failure(["--seed", "https://example.com", "--depth", "1.5"])).toMatch(/--depth/);
  });

  it("rejects out-of-range numeric flags", () => {
    expect(failure(["--seed", "https://example.com", "--max", "0"])).toMatch(/--max/);
    expect(failure(["--seed", "https://example.com", "--depth", "-1"])).toMatch(/--depth/);
    expect(failure(["--seed", "https://example.com", "--concurrency", "0"])).toMatch(
      /--concurrency/,
    );
    //Bounded because the delay applies to every request on a host, so a typo compounds
    //across the whole crawl rather than costing one request.
    expect(failure(["--seed", "https://example.com", "--delay", "600000"])).toMatch(/--delay/);
  });

  //strict parsing: a typo'd flag that parsed silently would run the crawl with the default
  //the user believed they had overridden.
  it("rejects unknown flags and bare positionals", () => {
    expect(failure(["--seed", "https://example.com", "--maxx", "5"])).toBeTruthy();
    expect(failure(["https://example.com"])).toBeTruthy();
  });

  it("takes --fresh as a boolean", () => {
    expect(options(["--seed", "https://example.com", "--fresh"]).fresh).toBe(true);
  });

  it("accepts --host as either a hostname or a URL, deduplicated", () => {
    const parsed = options([
      "--seed",
      "https://example.com",
      "--host",
      "docs.example.com",
      "--host",
      "https://blog.example.com/some/path",
      "--host",
      "DOCS.EXAMPLE.COM",
    ]);

    expect(parsed.hosts).toEqual(["docs.example.com", "blog.example.com"]);
  });

  //--help must answer before validation, or `npm run crawl -- --help` reports a missing
  //seed instead of telling the user what the flags are.
  it("answers --help before validating anything else", () => {
    const parsed = parseCrawlArgs(["--help"]);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.options.help).toBe(true);
    expect(parseCrawlArgs(["-h"]).ok).toBe(true);
  });
});
