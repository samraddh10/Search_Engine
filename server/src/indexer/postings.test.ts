//The collapse from one-entry-per-occurrence to one-entry-per-(term, document). Runs on real
//pipeline output rather than hand-built tokens: the thing worth pinning is that this module
//agrees with what 2.1 actually emits, and a fixture I wrote myself could only agree with my
//memory of it.
import { describe, expect, it } from "vitest";
import { indexableText, processText } from "../processing/pipeline.js";
import { buildDocumentPostings } from "./postings.js";

describe("buildDocumentPostings", () => {
  it("collapses repeated occurrences into one entry per term", () => {
    const postings = buildDocumentPostings(processText("crawler crawlers crawling pages"));

    expect([...postings.keys()]).toEqual(["crawler", "crawl", "page"]);
    expect(postings.get("crawler")).toMatchObject({ tf: 2, positions: [0, 1] });
    expect(postings.get("crawl")).toMatchObject({ tf: 1, positions: [2] });
  });

  //tf and positions are stored as separate columns, so the invariant that keeps them honest
  //belongs in a test rather than in a comment.
  it("keeps tf equal to the number of positions", () => {
    const postings = buildDocumentPostings(
      processText("Ranking ranked rankings: a page about ranking pages."),
    );

    for (const posting of postings.values()) {
      expect(posting.tf).toBe(posting.positions.length);
    }
  });

  //2.1 numbers over the full stream and never renumbers; the gaps are how a phrase query tells
  //"search engine" from "search the engine". Preserving them is this module's job too.
  it("preserves the gaps stopwords left in the numbering", () => {
    const postings = buildDocumentPostings(processText("crawler and the crawler"));

    expect(postings.get("crawler")).toMatchObject({ tf: 2, positions: [0, 3] });
  });

  it("keeps positions ascending", () => {
    const postings = buildDocumentPostings(
      processText("page one, page two, and page three, then a page four"),
    );

    const { positions } = postings.get("page")!;
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.length).toBeGreaterThan(1);
  });

  //The obligation 2.2 inherited: the index stores "comput", and 3.3 has to show a user
  //something they would recognize. Counts are what 2.3 breaks ties on.
  it("tallies the surface spellings that produced each stem", () => {
    const postings = buildDocumentPostings(
      processText("computers computers computing on a computer"),
    );

    expect(postings.get("comput")!.surfaces).toEqual(
      new Map([
        ["computers", 2],
        ["computing", 1],
        ["computer", 1],
      ]),
    );
  });

  it("returns an empty map for a document with no indexable tokens", () => {
    expect(buildDocumentPostings(processText(""))).toEqual(new Map());
    expect(buildDocumentPostings(processText("the and of to a"))).toEqual(new Map());
  });

  //2.3's bulk load and every test here read this map in iteration order, so the order has to be
  //a function of the document rather than of hash internals.
  it("orders terms by first appearance", () => {
    const postings = buildDocumentPostings(
      processText(indexableText({ title: "Search Engines", contentText: "A crawler indexes." })),
    );

    expect([...postings.keys()]).toEqual(["search", "engin", "crawler", "index"]);
  });
});
