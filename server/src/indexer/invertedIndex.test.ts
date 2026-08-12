//The corpus-level assertions: posting lists across documents, doc_freq, the corpus statistics
//BM25 will divide by, and the two contracts 2.2 hands forward — surface forms for 3.3 and
//position alignment for 3.2. No database: the module takes an iterable, so the fixture corpus
//is three object literals.
import { describe, expect, it } from "vitest";
import { normalizeToken } from "../processing/normalizer.js";
import { indexableText, processText } from "../processing/pipeline.js";
import {
  buildIndex,
  pickSurfaceForm,
  type IndexableDocument,
} from "./invertedIndex.js";

//Two documents whose overlap is deliberate: `crawler` and `page` appear in both (so doc_freq
//is 2 and the posting lists have to merge), while `engin` appears only in a title and `crawl`
//only in one body.
const CORPUS: IndexableDocument[] = [
  { id: 1, title: "Search Engines", contentText: "A crawler indexes pages." },
  { id: 2, title: "Crawling", contentText: "The crawler crawls pages and pages." },
];

describe("buildIndex", () => {
  it("inverts the corpus into posting lists keyed by stem", async () => {
    const index = await buildIndex(CORPUS);

    expect(index.terms.get("crawler")!.postings).toEqual([
      { docId: 1, tf: 1, positions: [3] },
      { docId: 2, tf: 1, positions: [2] },
    ]);
    expect(index.terms.get("page")!.postings).toEqual([
      { docId: 1, tf: 1, positions: [5] },
      { docId: 2, tf: 2, positions: [4, 6] },
    ]);
  });

  //doc_freq is the df in BM25's IDF, and it is the posting list's length rather than a second
  //stored count. This is the test that says so.
  it("carries doc_freq as the length of the posting list", async () => {
    const index = await buildIndex(CORPUS);

    expect(index.terms.get("crawler")!.postings).toHaveLength(2);
    expect(index.terms.get("index")!.postings).toHaveLength(1);

    for (const term of index.terms.values()) {
      const docIds = term.postings.map((posting) => posting.docId);
      //One posting per document, never two — the property that makes length a valid df.
      expect(new Set(docIds).size).toBe(docIds.length);
    }
  });

  //The reason `indexableText` exists. A term appearing only in a title would otherwise make the
  //page unmatchable by any query, with nothing anywhere to report the loss.
  it("indexes the title, not just the body", async () => {
    const index = await buildIndex(CORPUS);

    expect(index.terms.has("engin")).toBe(true);
    expect(index.terms.get("engin")!.postings).toEqual([{ docId: 1, tf: 1, positions: [1] }]);
  });

  it("records per-document token counts and the corpus statistics", async () => {
    const index = await buildIndex(CORPUS);

    expect(index.docLengths).toEqual(
      new Map([
        [1, 5],
        [2, 5],
      ]),
    );
    expect(index.stats).toEqual({ totalDocs: 2, totalTokens: 10, avgDocLen: 5 });
  });

  //token_count counts survivors, so a document of nothing but stopwords is length 0 — but it is
  //still a document, and BM25's N counts documents rather than non-empty ones.
  it("counts a document with no indexable tokens toward totalDocs", async () => {
    const index = await buildIndex([
      { id: 1, title: "", contentText: "the and of to a" },
      { id: 2, title: "Crawler", contentText: "" },
    ]);

    expect(index.docLengths.get(1)).toBe(0);
    expect(index.stats).toEqual({ totalDocs: 2, totalTokens: 1, avgDocLen: 0.5 });
  });

  //NaN here would propagate through every BM25 score and produce an unranked result list with
  //no error raised to explain it.
  it("reports avgDocLen 0 for an empty corpus rather than NaN", async () => {
    const index = await buildIndex([]);

    expect(index.terms.size).toBe(0);
    expect(index.stats).toEqual({ totalDocs: 0, totalTokens: 0, avgDocLen: 0 });
  });

  //The input is an iterable someone else supplies. A duplicate merges two documents' postings
  //into one entry while docLengths keeps only the last — corruption that would surface much
  //later as wrong scores, attributed to anything but this.
  it("throws when the same document id arrives twice", async () => {
    const duplicated = [...CORPUS, { id: 1, title: "Again", contentText: "Another crawler." }];

    await expect(buildIndex(duplicated)).rejects.toThrow(/document id 1 twice/);
  });

  //2.3 streams documents from a pg cursor; the tests hand over an array. Both have to work, or
  //the suite is proving something about a code path production does not take.
  it("accepts an async iterable as well as a plain array", async () => {
    async function* stream(): AsyncGenerator<IndexableDocument> {
      for (const doc of CORPUS) yield doc;
    }

    expect(await buildIndex(stream())).toEqual(await buildIndex(CORPUS));
  });

  it("is deterministic, including term and posting order", async () => {
    expect(await buildIndex(CORPUS)).toEqual(await buildIndex(CORPUS));
  });

  //The contract that makes 3.2 possible, and the one most easily broken by a later change:
  //postings store only the ordinal, so the snippet builder recovers character offsets by
  //re-running processText over indexableText(doc). If either side changed how title and body
  //are joined, every position in the document would shift and every snippet would quote the
  //wrong text. Asserting it here means such a change fails a test instead of shipping.
  it("stores positions that 3.2 can resolve back to the document text", async () => {
    const index = await buildIndex(CORPUS);
    const doc = CORPUS[0]!;
    const text = indexableText(doc);
    const tokens = processText(text);

    for (const [term, entry] of index.terms) {
      for (const posting of entry.postings) {
        if (posting.docId !== doc.id) continue;

        for (const position of posting.positions) {
          const token = tokens.find((candidate) => candidate.position === position);
          expect(token?.term).toBe(term);
          //The offsets have to land on the word that produced the term, not merely exist.
          expect(normalizeToken(text.slice(token!.start, token!.end))).toBe(token!.surface);
        }
      }
    }

    //Spot-check one by hand, so the loop above cannot pass vacuously on an empty index.
    const engin = index.terms.get("engin")!.postings[0]!;
    const token = tokens.find((candidate) => candidate.position === engin.positions[0])!;
    expect(text.slice(token.start, token.end)).toBe("Engines");
  });

  describe("surface forms", () => {
    it("aggregates spellings across the whole corpus, not per document", async () => {
      const index = await buildIndex([
        { id: 1, title: "", contentText: "computing" },
        { id: 2, title: "", contentText: "computers computers" },
      ]);

      expect(index.terms.get("comput")!.surfaceForm).toBe("computers");
    });

    it("gives every term a display spelling", async () => {
      const index = await buildIndex(CORPUS);

      for (const term of index.terms.values()) {
        expect(term.surfaceForm).not.toBe("");
      }
      expect(index.terms.get("engin")!.surfaceForm).toBe("engines");
    });
  });
});

//Tested directly rather than through a corpus: the tie-breaks are the whole point, and
//constructing text whose stems tie on count is a lot of indirection to express one Map.
describe("pickSurfaceForm", () => {
  it("picks the most frequent spelling", () => {
    expect(
      pickSurfaceForm(
        new Map([
          ["computing", 3],
          ["computers", 9],
          ["computer", 4],
        ]),
      ),
    ).toBe("computers");
  });

  //Without a tie-break the winner depends on which document was read first, so the same corpus
  //indexed twice could show a user different words.
  it("breaks a tie on count by the shorter spelling", () => {
    expect(
      pickSurfaceForm(
        new Map([
          ["computers", 5],
          ["computer", 5],
        ]),
      ),
    ).toBe("computer");
  });

  it("breaks a tie on count and length lexicographically", () => {
    expect(
      pickSurfaceForm(
        new Map([
          ["ranked", 2],
          ["ranker", 2],
        ]),
      ),
    ).toBe("ranked");
  });

  it("is independent of insertion order", () => {
    const entries: [string, number][] = [
      ["crawls", 2],
      ["crawling", 2],
      ["crawled", 2],
    ];

    expect(pickSurfaceForm(new Map(entries))).toBe("crawls");
    expect(pickSurfaceForm(new Map([...entries].reverse()))).toBe("crawls");
  });

  it("returns an empty string for an empty tally", () => {
    expect(pickSurfaceForm(new Map())).toBe("");
  });
});
