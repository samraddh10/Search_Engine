import { beforeEach, describe, expect, it } from "vitest";
import { clearStemCache, stem } from "./stemmer.js";

describe("stem", () => {
  beforeEach(() => {
    clearStemCache();
  });

  //Known answers, taken from the library's actual output rather than from memory. The point
  //of the table is regression: if the stemmer is ever swapped, these change, and changing
  //them means the whole corpus must be reindexed or every query silently misses.
  it("collapses inflected forms onto a shared root", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["computers", "comput"],
      ["computing", "comput"],
      ["computed", "comput"],
      ["indexing", "index"],
      ["indexes", "index"],
      ["searching", "search"],
      ["ranking", "rank"],
      ["pages", "page"],
      ["running", "run"],
      ["troubling", "troubl"],
      ["relational", "relat"],
      ["happiness", "happi"],
    ];

    for (const [word, expected] of cases) {
      expect(stem(word)).toBe(expected);
    }
  });

  //Two limitations worth pinning so nobody discovers them as bugs in Phase 3.
  //
  //Porter is a suffix rewriter, not a lemmatizer: it has no idea that "ran" is a form of
  //"run", so irregular verbs do not collapse. And "crawlers" stops at "crawler" while
  //"crawling" reaches "crawl", so the noun and the verb stay separate terms.
  it("does not collapse irregulars or every related pair", () => {
    expect(stem("ran")).not.toBe(stem("running"));
    expect(stem("crawlers")).toBe("crawler");
    expect(stem("crawling")).toBe("crawl");
  });

  //The other direction, and the reason terms.surface_form exists: the stem is not a word,
  //and unrelated words can share one. Autocomplete must never show these to a user.
  it("overstems distinct words onto one term", () => {
    expect(stem("university")).toBe("univers");
    expect(stem("universal")).toBe("univers");
  });

  it("leaves digits and short words untouched", () => {
    expect(stem("42")).toBe("42");
    expect(stem("a")).toBe("a");
    expect(stem("sing")).toBe("sing");
  });

  it("returns the same answer cached or uncached", () => {
    const cold = stem("indexing");
    const warm = stem("indexing");
    clearStemCache();

    expect(warm).toBe(cold);
    expect(stem("indexing")).toBe(cold);
  });

  it("handles the empty string without throwing", () => {
    expect(stem("")).toBe("");
  });
});
