import { describe, expect, it } from "vitest";
import { processQuery } from "../processing/pipeline.js";
import { SNIPPET_DEFAULTS, buildSnippet, type Snippet } from "./snippets.js";

//No database and no fixture server: 3.2 is a pure function over two strings, which is the whole
//reason the window arithmetic was split out of the query processor. Same shape as 2.1's and
//2.2's suites.

/** What the CLI renders, and the shortest way to read an assertion about offsets. */
function bracket({ snippet, matches }: Snippet): string {
  let out = "";
  let cursor = 0;

  for (const match of matches) {
    out += `${snippet.slice(cursor, match.start)}[${snippet.slice(match.start, match.end)}]`;
    cursor = match.end;
  }

  return out + snippet.slice(cursor);
}

/** The text each match actually covers — the only real check that the offsets landed. */
function matchedText({ snippet, matches }: Snippet): string[] {
  return matches.map((match) => snippet.slice(match.start, match.end));
}

const FILLER = "filler ".repeat(30).trim();

describe("buildSnippet", () => {
  it("returns a window around the match with offsets into the snippet", () => {
    const result = buildSnippet(
      { title: "Web Crawler", contentText: "The frontier queue holds urls to crawl." },
      ["frontier"],
    );

    expect(result.snippet).toBe("The frontier queue holds urls to crawl.");
    expect(matchedText(result)).toEqual(["frontier"]);
  });

  it("matches on stems, so a query stem highlights the inflected word in the text", () => {
    //`processQuery("crawling")` is `["crawl"]`, and the word in the document is `crawling` —
    //if the offsets came from anywhere but the re-run, this is where it would show.
    const result = buildSnippet(
      { title: "Guide", contentText: "A bot crawling the web politely." },
      processQuery("crawling"),
    );

    expect(matchedText(result)).toEqual(["crawling"]);
  });

  it("highlights every occurrence inside the window", () => {
    const result = buildSnippet(
      { title: "Guide", contentText: "crawler and crawler and crawler." },
      ["crawler"],
    );

    expect(bracket(result)).toBe("[crawler] and [crawler] and [crawler].");
  });

  it("prefers the window covering the most distinct stems, not the most matches", () => {
    //Four hits of one stem on the left, one hit of each on the right. A naive count picks the
    //left; distinct-first has to pick the right, or `documents containing` shows a snippet with
    //no `containing` in it.
    const contentText =
      `documents documents documents documents. ${FILLER} documents containing.`;

    //The budget has to be smaller than the gap, or both clusters fit one window and there is no
    //choice being tested — which is what the first version of this test got wrong.
    const result = buildSnippet({ title: "Guide", contentText }, ["document", "contain"], {
      maxLength: 80,
    });

    expect(result.snippet).toContain("containing");
    expect(matchedText(result)).toEqual(["documents", "containing"]);
  });

  it("marks a mid-document window with a leading ellipsis and offsets past it", () => {
    const contentText = `${FILLER} the frontier queue.`;

    const result = buildSnippet({ title: "Guide", contentText }, ["frontier"], {
      maxLength: 80,
    });

    expect(result.snippet.startsWith("… ")).toBe(true);
    //The load-bearing assertion of the whole module: `… ` shifts every offset by two, and an
    //un-shifted offset would quietly bracket the word to the left.
    expect(matchedText(result)).toEqual(["frontier"]);
  });

  it("does not mark a window that starts at the body or ends at the document", () => {
    const result = buildSnippet(
      { title: "Guide", contentText: "A short body about crawlers." },
      ["crawler"],
    );

    expect(result.snippet).toBe("A short body about crawlers.");
  });

  it("never quotes the title, even when only the title matched", () => {
    //The stem is in the title and nowhere else, so the body-only filter finds nothing and the
    //lead fallback runs. The title is already rendered above the snippet in the UI.
    const result = buildSnippet(
      { title: "Crawler Documentation", contentText: "The frontier holds urls." },
      ["document"],
    );

    expect(result.snippet).toBe("The frontier holds urls.");
    expect(result.matches).toEqual([]);
  });

  it("falls back to the head of the body when nothing matched", () => {
    const result = buildSnippet(
      { title: "Guide", contentText: `${FILLER} tail` },
      ["absent"],
      { maxLength: 80 },
    );

    expect(result.snippet.startsWith("filler filler")).toBe(true);
    expect(result.snippet.endsWith(" …")).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it("returns an empty snippet for a document with no body", () => {
    expect(buildSnippet({ title: "Title only", contentText: "" }, ["title"])).toEqual({
      snippet: "",
      matches: [],
    });
  });

  it("keeps the window inside the character budget", () => {
    const contentText = `${FILLER} frontier ${FILLER}`;

    const result = buildSnippet({ title: "Guide", contentText }, ["frontier"], {
      maxLength: 100,
    });

    //Ellipses are added on top of the budget, so they come off before measuring.
    const core = result.snippet.replace(/^… /, "").replace(/ …$/, "");
    expect(core.length).toBeLessThanOrEqual(100);
  });

  it("does not cut words at either edge", () => {
    const contentText = `${FILLER} frontier ${FILLER}`;

    const result = buildSnippet({ title: "Guide", contentText }, ["frontier"], {
      maxLength: 100,
    });

    const core = result.snippet.replace(/^… /, "").replace(/ …$/, "");
    expect(core.startsWith("filler")).toBe(true);
    expect(core.endsWith("filler")).toBe(true);
  });

  it("flattens block separators to spaces without moving the offsets", () => {
    //1.3 emits `\n` between block elements. A space is exactly as long, which is what makes the
    //substitution safe — any collapsing transform would need an index mapping to stay correct.
    const result = buildSnippet(
      { title: "Guide", contentText: "First block.\nSecond block on the frontier." },
      ["frontier"],
    );

    expect(result.snippet).toBe("First block. Second block on the frontier.");
    expect(matchedText(result)).toEqual(["frontier"]);
  });

  it("clamps a budget too small to hold a single token", () => {
    const result = buildSnippet(
      { title: "Guide", contentText: `${FILLER} frontier ${FILLER}` },
      ["frontier"],
      { maxLength: 1 },
    );

    expect(matchedText(result)).toEqual(["frontier"]);
  });

  it("returns matches in order, non-overlapping, and inside the snippet", () => {
    const contentText = `crawler ${FILLER} crawler frontier crawler`;

    const result = buildSnippet({ title: "Guide", contentText }, ["crawler", "frontier"]);

    let previous = 0;
    for (const match of result.matches) {
      expect(match.start).toBeGreaterThanOrEqual(previous);
      expect(match.end).toBeGreaterThan(match.start);
      expect(match.end).toBeLessThanOrEqual(result.snippet.length);
      previous = match.end;
    }

    expect(result.matches.length).toBeGreaterThan(1);
  });

  it("defaults to the documented budget", () => {
    expect(SNIPPET_DEFAULTS.maxLength).toBe(300);

    const contentText = `${"word ".repeat(400)}frontier`;
    const result = buildSnippet({ title: "Guide", contentText }, ["frontier"]);

    expect(result.snippet.replace(/^… /, "").length).toBeLessThanOrEqual(300);
  });
});
