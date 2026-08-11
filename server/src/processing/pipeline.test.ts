//The integration point for 2.1. The individual modules are covered beside their own files;
//what is pinned here is the composition — the order of the four steps, and the three
//contracts the pipeline hands forward to 2.2, 2.3 and 3.2.
import { describe, expect, it } from "vitest";
import { processQuery, processText } from "./pipeline.js";

describe("processText", () => {
  it("runs the full pipeline in order", () => {
    const tokens = processText("The Crawlers are indexing résumés — 42 pages!");

    expect(tokens.map((token) => token.term)).toEqual([
      "crawler",
      "index",
      "resum",
      "42",
      "page",
    ]);
  });

  //2.2 tallies these per stem so 2.3 can fill terms.surface_form. The index stores "resum";
  //3.3's autocomplete has to be able to show the user something they would recognize.
  it("keeps the normalized but unstemmed spelling alongside the stem", () => {
    const tokens = processText("Indexing résumés");

    expect(tokens.map((token) => [token.surface, token.term])).toEqual([
      ["indexing", "index"],
      ["resumes", "resum"],
    ]);
  });

  //Positions are assigned over the full stream, before stopwords are dropped, and never
  //renumbered. Renumbering the survivors would make the two phrases below identical, so a
  //phrase query for "search engine" would match text that does not contain the phrase.
  it("numbers positions over the full token stream, gaps and all", () => {
    const tokens = processText("the search engine is fast");

    expect(tokens.map((token) => [token.surface, token.position])).toEqual([
      ["search", 1],
      ["engine", 2],
      ["fast", 4],
    ]);
  });

  it("distinguishes an adjacent pair from one separated by a stopword", () => {
    const adjacent = processText("search engine");
    const separated = processText("search the engine");

    expect(adjacent.map((token) => token.position)).toEqual([0, 1]);
    expect(separated.map((token) => token.position)).toEqual([0, 2]);
  });

  //3.2's contract. postings stores only the ordinal, so the snippet builder re-runs this
  //function over documents.content_text and reads the offsets off the token it names. That
  //only works if the offsets index the *raw* input — normalization changes string length,
  //so offsets into the normalized form would drift after the first ligature or accent.
  it("reports offsets into the raw input, not the normalized form", () => {
    const input = "A ﬁle about résumés and indexing.";

    for (const token of processText(input)) {
      //The slice is the original spelling, which normalizes to the surface form we stored.
      expect(input.slice(token.start, token.end).length).toBe(token.end - token.start);
    }

    const [file] = processText(input);
    expect(input.slice(file!.start, file!.end)).toBe("ﬁle");
    expect(file!.surface).toBe("file");
  });

  //Ordering: the stopword check runs on the normalized, unstemmed form. Consulted after the
  //stemmer it would see "doe" for "does" and let it through.
  it("drops stopwords in the form they appear, including contractions", () => {
    expect(processText("it does not")).toEqual([]);
    expect(processText("they're not; we don't")).toEqual([]);
    expect(processText("Don’t stop")).toMatchObject([{ surface: "stop" }]);
  });

  it("returns an empty array rather than throwing on degenerate input", () => {
    expect(processText("")).toEqual([]);
    expect(processText("   \n\t ")).toEqual([]);
    expect(processText("--- !!! ...")).toEqual([]);
    expect(processText("the and of to a")).toEqual([]);
  });

  //A run that normalizes away entirely never held a term, so it must not consume a position
  //either — a hole in the numbering reads like a dropped stopword to a phrase query.
  it("does not spend a position on a token that normalizes to nothing", () => {
    const tokens = processText("search \u0301 engine");

    expect(tokens.map((token) => token.position)).toEqual([0, 1]);
  });

  //documents.token_count, and therefore BM25's document length and corpus_stats.avg_doc_len.
  //Counts survivors, so the length a document is penalized for is the length its postings
  //actually represent.
  it("returns exactly the tokens that will be indexed", () => {
    expect(processText("The quick brown fox jumps over the lazy dog")).toHaveLength(6);
  });

  it("is deterministic", () => {
    const input = "Crawling, indexing and ranking 42 résumés.";
    expect(processText(input)).toEqual(processText(input));
  });
});

describe("processQuery", () => {
  //The property the whole module exists to guarantee. If the index side and the query side
  //ever diverge, /search returns nothing for a query that plainly matches, and no error is
  //raised anywhere to say so.
  it("produces the same terms the indexer would store for the same text", () => {
    const text = "Indexing résumés and ranking pages";

    expect(processQuery(text)).toEqual(processText(text).map((token) => token.term));
  });

  it("finds the stored term from a differently inflected query", () => {
    const indexed = processText("A page about computing.").map((token) => token.term);

    expect(processQuery("computers")).toEqual(["comput"]);
    expect(indexed).toContain("comput");
  });

  it("keeps duplicates and query order", () => {
    expect(processQuery("rank rank search")).toEqual(["rank", "rank", "search"]);
  });

  it("returns an empty array for a query with no content words", () => {
    expect(processQuery("the and of")).toEqual([]);
    expect(processQuery("")).toEqual([]);
  });
});
