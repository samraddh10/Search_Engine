import { describe, expect, it } from "vitest";
import { normalizeToken } from "./normalizer.js";
import { isStopword, STOPWORDS } from "./stopwords.js";
import { stem } from "./stemmer.js";

describe("stopwords", () => {
  it("matches the common function words", () => {
    for (const word of ["the", "and", "is", "of", "to", "a", "with", "for"]) {
      expect(isStopword(word)).toBe(true);
    }
  });

  it("leaves content words alone", () => {
    for (const word of ["crawler", "index", "ranking", "search", "page", "42"]) {
      expect(isStopword(word)).toBe(false);
    }
  });

  //The one test in this file that could actually catch a silent bug. Entries are stored in
  //the form normalizeToken produces, so a plausible-looking "don't" or "The" in the list
  //would never match anything the tokenizer emits — it would sit there as dead weight,
  //looking correct in review, while the word it names went on being indexed.
  it("stores every entry in its already-normalized form", () => {
    for (const entry of STOPWORDS) {
      expect(normalizeToken(entry)).toBe(entry);
    }
  });

  it("covers the contractions in the form the pipeline will produce", () => {
    expect(isStopword(normalizeToken("don't"))).toBe(true);
    expect(isStopword(normalizeToken("isn’t"))).toBe(true);
    expect(isStopword(normalizeToken("They're"))).toBe(true);
  });

  //Why isStopword takes an unstemmed token. Porter rewrites several list entries into forms
  //that are not themselves in the list, so a check placed after the stemmer would let the
  //words most worth dropping straight through. This asserts the trap exists rather than
  //asserting it has been avoided — pipeline.test.ts covers the ordering itself.
  it("would miss entries if it were consulted after stemming", () => {
    const escapes = [...STOPWORDS].filter((word) => !STOPWORDS.has(stem(word)));

    expect(escapes.length).toBeGreaterThan(0);
    expect(stem("does")).toBe("doe");
    expect(isStopword("doe")).toBe(false);
  });

  it("is non-trivially sized", () => {
    //A guard against an accidental truncation of the literal, not a target to tune toward.
    expect(STOPWORDS.size).toBeGreaterThan(100);
  });
});
