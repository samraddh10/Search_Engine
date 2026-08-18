import type { SearchMatch } from "shared";
import { checkPgHealth, closePg, pgPool } from "../db/pg.js";
import type { CorpusStats } from "../indexer/invertedIndex.js";
import { searchQuery, type SearchedPage } from "../search/queryProcessor.js";
import { idf } from "./bm25.js";
import type { TermPostings } from "./scorer.js";
import { USAGE, parseSearchArgs, type SearchCliOptions } from "./searchArgs.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;


//Purpose of this function: the top-level orchestration — parse the CLI args, connect to Postgres, run the search, print results, and clean up. This is the function that actually gets invoked when you run npm run search -- "some query".
async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseSearchArgs(argv);

  if (!parsed.ok) {
    console.error(`search: ${parsed.message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }

  const options = parsed.options;
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  if (!(await checkPgHealth())) {
    console.error(
      "search: cannot reach Postgres. Check DATABASE_URL in server/.env, and that " +
        "`docker compose up -d` is running.",
    );
    return EXIT_ERROR;
  }

  try {
    
    const startedAt = Date.now();

    const page = await searchQuery(pgPool, {
      query: options.query,
      pageSize: options.limit,
      k1: options.k1,
      b: options.b,
    });

    const elapsedMs = Date.now() - startedAt;

    //The three zero-result outcomes are three different things to say. Collapsing them would
    //make this print "No matches" for a query that never reached the index.
    if (page.status === "no-searchable-terms") {
      console.error(
        `search: "${options.query}" has no searchable terms — every word was a stopword or ` +
          "normalized away.",
      );
      return EXIT_OK;
    }

    if (page.status === "empty-index") {
      console.error(
        "search: the index is empty. Run `npm run crawl` and then `npm run index` first.",
      );
      return EXIT_OK;
    }

    console.log(formatResults(options, page, elapsedMs));

    return EXIT_OK;
  } finally {
    //In a finally so a thrown query still releases the pool; without it the process hangs on
    //an open handle instead of reporting what went wrong.
    await closePg();
  }
}

//Purpose of this function: turn a SearchedPage (the raw, structured result of the search) into a nicely formatted, human-readable multi-line string ready to print to the terminal.
function formatResults(
  options: SearchCliOptions,
  page: SearchedPage,
  elapsedMs: number,
): string {
  const lines: string[] = ["", `Query: ${page.query}`, `Stems: ${page.stems.join(", ")}`];

  if (options.explain) {
    lines.push("", explainTerms(page.stems, page.terms, page.stats));
  }

  if (page.total === 0) {
    lines.push(
      "",
      "No matches. Every query term is absent from the index — check `npm run index` has " +
        "run since the last crawl.",
      "",
    );

    return lines.join("\n");
  }

  //shown — how many results are actually in this page
  const shown = page.results.length;
  //indexed — total documents in the whole corpus, formatted with .toLocaleString("en-US")
  const indexed = page.stats.totalDocs.toLocaleString("en-US");

  //3.1 reports the whole candidate set, so this can now distinguish "3 results" from "3 of 400"
  //— which the old version could not, because it only ever held the truncated list.
  const count =
    shown === page.total
      ? `${page.total} result${page.total === 1 ? "" : "s"}`
      : `${page.total.toLocaleString("en-US")} results, showing ${shown}`;

  lines.push("", `${count} (${indexed} documents indexed, ${elapsedMs}ms)`, "");

  const width = String(shown).length;

  page.results.forEach((result, position) => {
    const rank = String(position + 1).padStart(width);

    //A crawled page may legitimately have no <title>; the column defaults to ''. Showing the
    //URL twice reads better than an empty line where a heading should be.
    const title = result.title.trim();

    const indent = " ".repeat(width + 2);

    lines.push(
      `${rank}. ${result.score.toFixed(4)}  ${title === "" ? result.url : title}`,
      `${indent}${result.url}`,
      `${indent}${highlight(result.snippet, result.matches)}`,
      `${indent}matched: ${result.matchedTerms.join(", ")}`,
      "",
    );
  });

  return lines.join("\n");
}

/**
 * Bracket each match, reading the offsets rather than searching for the terms again.
 *
 * That is the point of doing it this way: rendering through the offsets is the only end-to-end
 * check that 3.2's arithmetic is right. An off-by-two from the `… ` prefix shows up here as a
 * bracket sitting one word to the left, which is exactly how it would show up in the browser.
 */
function highlight(snippet: string, matches: readonly SearchMatch[]): string {
  let out = "";
  let cursor = 0;

  for (const match of matches) {
    out += `${snippet.slice(cursor, match.start)}[${snippet.slice(match.start, match.end)}]`;
    cursor = match.end;
  }

  return out + snippet.slice(cursor);
}

//Purpose of this function: produce the --explain diagnostic table — a per-query-term breakdown showing each stem's document frequency, IDF weight, 
// and how many documents it actually matched.
function explainTerms(
  stems: readonly string[],
  terms: readonly TermPostings[],
  stats: CorpusStats,
): string {
  const byTerm = new Map(terms.map((entry) => [entry.term, entry]));

  const rows = stems.map((stem) => {
    const entry = byTerm.get(stem);
    const docFreq = entry?.docFreq ?? 0;

    return {
      stem,
      docFreq: entry === undefined ? "not indexed" : docFreq.toLocaleString("en-US"),
      idf: idf(docFreq, stats.totalDocs).toFixed(4),
      matches: (entry?.postings.length ?? 0).toLocaleString("en-US"),
    };
  });

  const stemWidth = Math.max(4, ...rows.map((row) => row.stem.length));
  const freqWidth = Math.max(2, ...rows.map((row) => row.docFreq.length));

  const header =
    `  ${"stem".padEnd(stemWidth)}  ${"df".padStart(freqWidth)}  ${"idf".padStart(7)}  postings`;

  const body = rows
    .map(
      (row) =>
        `  ${row.stem.padEnd(stemWidth)}  ${row.docFreq.padStart(freqWidth)}  ` +
        `${row.idf.padStart(7)}  ${row.matches}`,
    )
    .join("\n");

  return [
    `Terms (N = ${stats.totalDocs.toLocaleString("en-US")}, avgdl = ${stats.avgDocLen.toFixed(1)})`,
    header,
    body,
  ].join("\n");
}

//Diagnostics to stderr, results to stdout — 1.7's split, so `npm run search "x" > hits.txt`
//leaves a clean artifact while the errors still reach the terminal.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("search: failed —", error);
    process.exitCode = EXIT_ERROR;
  });
