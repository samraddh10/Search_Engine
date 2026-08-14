import { describe, expect, it } from "vitest";
import { BM25_DEFAULTS } from "./bm25.js";
import { SEARCH_DEFAULTS, parseSearchArgs } from "./searchArgs.js";

// No infrastructure at all — which is the entire reason flag parsing is split out of cli.ts,
// exactly as 1.7 split cliArgs.ts and 2.3 split indexArgs.ts.

function options(argv: string[]) {
  const parsed = parseSearchArgs(argv);
  if (!parsed.ok) throw new Error(`expected a successful parse, got: ${parsed.message}`);
  return parsed.options;
}

describe("parseSearchArgs", () => {
  it("takes the query from a quoted positional", () => {
    expect(options(["web crawler"]).query).toBe("web crawler");
  });

  // So an unquoted `npm run search -- web crawler` means what the user obviously intended
  // instead of erroring on the second word.
  it("joins several positionals into one query", () => {
    expect(options(["web", "crawler"]).query).toBe("web crawler");
  });

  it("defaults limit, k1 and b", () => {
    const parsed = options(["web"]);

    expect(parsed.limit).toBe(SEARCH_DEFAULTS.limit);
    expect(parsed.k1).toBe(BM25_DEFAULTS.k1);
    expect(parsed.b).toBe(BM25_DEFAULTS.b);
    expect(parsed.explain).toBe(false);
  });

  it("reads the tuning flags", () => {
    const parsed = options(["web", "--limit", "3", "--k1", "2", "--b", "0.4", "--explain"]);

    expect(parsed.limit).toBe(3);
    expect(parsed.k1).toBe(2);
    expect(parsed.b).toBe(0.4);
    expect(parsed.explain).toBe(true);
  });

  it("requires a query", () => {
    expect(parseSearchArgs([])).toMatchObject({ ok: false });
    expect(parseSearchArgs(["   "])).toMatchObject({ ok: false });
  });

  it("returns help without needing a query", () => {
    expect(options(["--help"]).help).toBe(true);
    expect(options(["-h"]).help).toBe(true);
  });

  // parseArgs alone would let this through as NaN, which slices nothing off the result list
  // and looks like an empty corpus rather than a bad flag.
  it("rejects a non-numeric limit instead of coercing it to NaN", () => {
    expect(parseSearchArgs(["web", "--limit", "abc"])).toMatchObject({ ok: false });
  });

  it("rejects a limit of zero or below", () => {
    expect(parseSearchArgs(["web", "--limit", "0"])).toMatchObject({ ok: false });
    expect(parseSearchArgs(["web", "--limit", "-5"])).toMatchObject({ ok: false });
  });

  // b outside 0..1 is not a stronger version of length normalization, it is a different and
  // incoherent function — above 1, a short document's norm goes negative.
  it("bounds b to 0..1", () => {
    expect(parseSearchArgs(["web", "--b", "1.5"])).toMatchObject({ ok: false });
    expect(parseSearchArgs(["web", "--b", "-0.1"])).toMatchObject({ ok: false });
    expect(options(["web", "--b", "0"]).b).toBe(0);
    expect(options(["web", "--b", "1"]).b).toBe(1);
  });

  it("rejects a negative k1, which would make repetition lower a score", () => {
    expect(parseSearchArgs(["web", "--k1", "-1"])).toMatchObject({ ok: false });
  });

  // A typo'd flag that parsed silently would run the search with the parameters the user
  // believed they had overridden.
  it("rejects an unknown flag", () => {
    const parsed = parseSearchArgs(["web", "--limitt", "3"]);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/limitt/);
  });
});
