import { describe, expect, it } from "vitest";
import { MAX_TOKEN_LENGTH, tokenize } from "./tokenizer.js";

function texts(input: string): string[] {
  return tokenize(input).map((token) => token.text);
}

describe("tokenize", () => {
  it("splits on whitespace and punctuation", () => {
    expect(texts("The crawler, indexing pages.")).toEqual([
      "The",
      "crawler",
      "indexing",
      "pages",
    ]);
  });

  //The contract 3.2 depends on: a posting names a token, and the snippet builder has to turn
  //that back into a character window in `documents.content_text`. If an offset is off by one
  //the snippet is silently misaligned, which no other test would notice.
  it("reports offsets that slice the original string back out", () => {
    const input = "  Ranking\tdocuments — résumé, 42.\nDone.  ";

    for (const token of tokenize(input)) {
      expect(input.slice(token.start, token.end)).toBe(token.text);
      expect(token.end - token.start).toBe(token.text.length);
    }
  });

  it("does not normalize; the raw slice is preserved", () => {
    expect(texts("Résumé ﬁle")).toEqual(["Résumé", "ﬁle"]);
  });

  //Without the apostrophe continuation this is "don" plus a bare "t", and that "t" becomes a
  //real term with a posting list in every document containing any contraction.
  it("keeps contractions whole, straight and curly alike", () => {
    expect(texts("don't stop it's fine")).toEqual(["don't", "stop", "it's", "fine"]);
    expect(texts("don’t")).toEqual(["don’t"]);
    expect(texts("O'Brien")).toEqual(["O'Brien"]);
  });

  //A trailing apostrophe is not a continuation — there is nothing after it to continue into.
  it("does not swallow a trailing apostrophe", () => {
    expect(texts("rock 'n' roll")).toEqual(["rock", "n", "roll"]);
    expect(texts("the dogs' bowls")).toEqual(["the", "dogs", "bowls"]);
  });

  it("splits hyphenated compounds into their parts", () => {
    expect(texts("state-of-the-art")).toEqual(["state", "of", "the", "art"]);
  });

  it("keeps digits and alphanumeric runs", () => {
    expect(texts("42 pages, v2 of 3")).toEqual(["42", "pages", "v2", "of", "3"]);
    //Dots are separators, so a version string breaks apart. Documented, not accidental.
    expect(texts("v1.2.3")).toEqual(["v1", "2", "3"]);
  });

  //\w is ASCII-only and would return nothing at all for these.
  it("tokenizes non-Latin scripts", () => {
    expect(texts("Привет мир")).toEqual(["Привет", "мир"]);
    expect(texts("Καλημέρα κόσμε")).toEqual(["Καλημέρα", "κόσμε"]);
  });

  //Known limitation, pinned so it is a decision rather than a surprise: CJK does not
  //separate words with spaces, so whitespace segmentation yields one token per run. Proper
  //support needs a dictionary-based segmenter and is out of scope for this corpus.
  it("treats an unspaced CJK run as a single token", () => {
    expect(texts("日本語のテキスト")).toEqual(["日本語のテキスト"]);
  });

  it("drops runs longer than the cap without disturbing their neighbours", () => {
    const blob = "a".repeat(MAX_TOKEN_LENGTH + 1);
    expect(texts(`before ${blob} after`)).toEqual(["before", "after"]);

    //Exactly at the cap is kept — the boundary is inclusive.
    expect(texts("a".repeat(MAX_TOKEN_LENGTH))).toHaveLength(1);
  });

  it("returns an empty array for input with nothing in it", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \n\t  ")).toEqual([]);
    expect(tokenize("--- ... !!!")).toEqual([]);
  });

  //The /g regex is shared at module scope; matchAll is specified to clone rather than
  //advance the original's lastIndex, but a refactor to an exec() loop would break exactly
  //this and pass every other test in the file.
  it("does not carry state between calls", () => {
    const input = "alpha beta gamma";
    expect(texts(input)).toEqual(texts(input));
    expect(texts(input)).toEqual(["alpha", "beta", "gamma"]);
  });
});
