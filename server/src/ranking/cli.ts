//Phase 2.4 — `npm run search`, a debug entry point rather than a product.
//
//2.3's CLI prints `corpus_stats` as *read back* from Postgres because a summary printed from
//memory looks identical whether or not the round trip worked. Ranking has the same gap in a
//sharper form: hand-computed known-answer vectors prove the arithmetic, not that the orderings
//are sensible on real pages. This is the only way to look at that before Phase 3 — and with
//the TF-IDF baseline dropped, there is no second scorer to look at it through.
//
//Same composition-root rule as `crawler/cli.ts` and `indexer/cli.ts`: this is the one file
//under `ranking/` that imports `db/pg.js`.
import { checkPgHealth, closePg, pgPool } from "../db/pg.js";
//Read through 2.3's function, never with a raw query — it is the single place
//`corpus_stats.total_tokens` stops being the string node-postgres returns for a BIGINT.
import { readCorpusStats } from "../indexer/indexStore.js";
import { processQuery } from "../processing/pipeline.js";
import { idf } from "./bm25.js";
import { rankDocuments, uniqueTerms, type ScoredDocument } from "./scorer.js";
import { fetchDocuments, fetchTermPostings, type DocumentSummary } from "./searchStore.js";
import { USAGE, parseSearchArgs, type SearchCliOptions } from "./searchArgs.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;

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
    //The same pipeline the indexer ran, by construction rather than by two modules agreeing to
    //be careful — `processQuery` is a thin wrapper over `processText` for exactly this reason.
    //An index built with one tokenizer and queried with another silently returns nothing.
    const stems = uniqueTerms(processQuery(options.query));

    if (stems.length === 0) {
      console.error(
        `search: "${options.query}" has no searchable terms — every word was a stopword or ` +
          "normalized away.",
      );
      return EXIT_OK;
    }

    const stats = await readCorpusStats(pgPool);

    if (stats.totalDocs === 0) {
      console.error(
        "search: the index is empty. Run `npm run crawl` and then `npm run index` first.",
      );
      return EXIT_OK;
    }

    const startedAt = Date.now();

    const terms = await fetchTermPostings(pgPool, stems);
    const ranked = rankDocuments(terms, stats, {
      limit: options.limit,
      k1: options.k1,
      b: options.b,
    });

    //Only the page being shown is hydrated. `documents` holds `content_text`, so joining it
    //into the scoring query would make the expensive half of a search the half nobody reads.
    const documents = await fetchDocuments(
      pgPool,
      ranked.map((result) => result.docId),
    );

    const elapsedMs = Date.now() - startedAt;

    console.log(formatResults(options, stems, terms, stats, ranked, documents, elapsedMs));

    return EXIT_OK;
  } finally {
    //In a finally so a thrown query still releases the pool; without it the process hangs on
    //an open handle instead of reporting what went wrong.
    await closePg();
  }
}

type TermReport = Awaited<ReturnType<typeof fetchTermPostings>>;
type Stats = Awaited<ReturnType<typeof readCorpusStats>>;

function formatResults(
  options: SearchCliOptions,
  stems: readonly string[],
  terms: TermReport,
  stats: Stats,
  ranked: readonly ScoredDocument[],
  documents: ReadonlyMap<number, DocumentSummary>,
  elapsedMs: number,
): string {
  const lines: string[] = ["", `Query: ${options.query}`, `Stems: ${stems.join(", ")}`];

  if (options.explain) {
    lines.push("", explainTerms(stems, terms, stats));
  }

  if (ranked.length === 0) {
    lines.push(
      "",
      "No matches. Every query term is absent from the index — check `npm run index` has " +
        "run since the last crawl.",
      "",
    );

    return lines.join("\n");
  }

  lines.push(
    "",
    `${ranked.length} result${ranked.length === 1 ? "" : "s"} ` +
      `(${stats.totalDocs.toLocaleString("en-US")} documents indexed, ${elapsedMs}ms)`,
    "",
  );

  const width = String(ranked.length).length;

  ranked.forEach((result, position) => {
    const document = documents.get(result.docId);
    const rank = String(position + 1).padStart(width);

    //A crawled page may legitimately have no <title>; the column defaults to ''. Showing the
    //URL twice reads better than an empty line where a heading should be.
    const title = document?.title.trim() ?? "";
    const url = document?.url ?? `(document ${result.docId} is gone)`;

    lines.push(
      `${rank}. ${result.score.toFixed(4)}  ${title === "" ? url : title}`,
      `${" ".repeat(width + 2)}${url}`,
      `${" ".repeat(width + 2)}matched: ${result.matchedTerms.join(", ")}`,
      "",
    );
  });

  return lines.join("\n");
}

/**
 * Per-term breakdown, which is the half of `--explain` that makes a surprising ranking
 * legible: a term in nearly every document has an IDF near zero and is contributing almost
 * nothing, and a term absent from `terms` entirely is contributing literally nothing.
 */
function explainTerms(stems: readonly string[], terms: TermReport, stats: Stats): string {
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
