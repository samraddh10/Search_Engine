//Pure string function, no fixtures and no database. Most of these are known-answer cases:
//the failures worth catching are the ones where a page indexes fine and is simply never
//found, because the term it was stored under is one no user will ever type.
import { describe, expect, it } from "vitest";
import { normalizeToken } from "./normalizer.js";

describe("normalizeToken", () => {
  it("lowercases", () => {
    expect(normalizeToken("Crawler")).toBe("crawler");
    expect(normalizeToken("HTTP")).toBe("http");
  });

  //The locale trap: toLocaleLowerCase under a Turkish locale maps I to the dotless ı, which
  //would make the index depend on the machine that built it. İ also lowercases to i plus a
  //combining dot, which the mark strip has to remove for this to land on plain "istanbul".
  it("lowercases the same way regardless of locale", () => {
    expect(normalizeToken("İstanbul")).toBe("istanbul");
    expect(normalizeToken("I")).toBe("i");
  });

  //NFKC. Each of these looks like ASCII in a browser and is not, so without the fold they
  //become terms that are unreachable from a normal keyboard.
  it("folds compatibility characters onto their plain equivalents", () => {
    expect(normalizeToken("ﬁle")).toBe("file"); //U+FB01 ligature
    expect(normalizeToken("ｓｅａｒｃｈ")).toBe("search"); //full-width, common on CJK pages
    expect(normalizeToken("²")).toBe("2");
  });

  it("strips Latin accents so plain-ASCII typing matches accented text", () => {
    expect(normalizeToken("résumé")).toBe("resume");
    expect(normalizeToken("naïve")).toBe("naive");
    expect(normalizeToken("Zürich")).toBe("zurich");
    //Precomposed é (U+00E9) and decomposed e + U+0301 must land on the same term, or the
    //same word typed two ways splits into two posting lists.
    expect(normalizeToken("caf\u00e9")).toBe(normalizeToken("cafe\u0301"));
  });

  //The reason the strip is a U+0300-U+036F range rather than \p{M}. In these scripts the
  //mark is part of the word, and removing it merges words that are not the same word.
  it("leaves non-Latin combining marks alone", () => {
    const arabic = "بَ"; //beh + fatha
    expect(normalizeToken(arabic)).toBe(arabic);

    const devanagari = "कि"; //ka + vowel sign i
    expect(normalizeToken(devanagari)).toBe(devanagari);
  });

  it("absorbs apostrophes, straight and curly alike", () => {
    expect(normalizeToken("don't")).toBe("dont");
    expect(normalizeToken("don’t")).toBe("dont");
    expect(normalizeToken("O'Brien")).toBe("obrien");
  });

  //NFKC expands ½ to 1⁄2, whose U+2044 fraction slash is not a letter or a digit and would
  //otherwise survive into a stored term.
  it("removes punctuation introduced by the compatibility fold itself", () => {
    expect(normalizeToken("½")).toBe("12");
  });

  it("keeps digits and non-Latin scripts", () => {
    expect(normalizeToken("42")).toBe("42");
    expect(normalizeToken("Привет")).toBe("привет");
    expect(normalizeToken("日本語")).toBe("日本語");
  });

  //Callers must drop these rather than store an empty term; pipeline.ts does.
  it("returns an empty string when nothing searchable is left", () => {
    expect(normalizeToken("")).toBe("");
    expect(normalizeToken("---")).toBe("");
    expect(normalizeToken("\u0301")).toBe(""); //a bare combining acute
  });

  it("is idempotent", () => {
    for (const word of ["résumé", "ﬁle", "don’t", "İstanbul", "½"]) {
      const once = normalizeToken(word);
      expect(normalizeToken(once)).toBe(once);
    }
  });
});
