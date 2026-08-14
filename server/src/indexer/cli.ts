//Phase 2.3 — `npm run index`, and Phase 2's composition root.
//
//1.7 exists because something has to open connections, parse flags and handle signals while
//1.1-1.6 stay pure enough to test. Phase 2 had the same gap and no subphase owning it:
//`processText`, `buildIndex` and `writeIndex` all take their inputs as arguments, so until
//this file existed nothing could actually run them. Same rule as `crawler/cli.ts` — an
//import of `db/pg.js` anywhere else under `indexer/` undoes the point of it.
import { checkPgHealth, closePg, pgPool } from "../db/pg.js";
import { USAGE, parseIndexArgs } from "./indexArgs.js";
import {
  readCorpusStats,
  streamDocuments,
  writeIndex,
  type IndexWriteStats,
} from "./indexStore.js";
import { buildIndex, type BuiltIndex } from "./invertedIndex.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseIndexArgs(argv);

  if (!parsed.ok) {
    console.error(`index: ${parsed.message}\n`);
    console.error(USAGE);
    return EXIT_ERROR;
  }

  const options = parsed.options;
  if (options.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  //Checked before the build rather than before the write. The build is the expensive half —
  //minutes of tokenizing and stemming — and discovering afterwards that there is nowhere to
  //put the result throws all of it away.
  if (!(await checkPgHealth())) {
    console.error(
      "index: cannot reach Postgres. Check DATABASE_URL in server/.env, and that " +
        "`docker compose up -d` is running.",
    );
    return EXIT_ERROR;
  }

  try {
    const startedAt = Date.now();

    console.error("Reading documents and building the index…");

    let read = 0;
    const documents = async function* () {
      for await (const document of streamDocuments(pgPool, {
        batchSize: options.readBatchSize,
      })) {
        read += 1;
        //Rewritten in place rather than one line per document: a corpus of thousands would
        //otherwise bury the summary, and unlike a crawl there is no per-item outcome worth
        //keeping. Only when stderr is a TTY — redirected output gets one line at the end.
        if (process.stderr.isTTY && read % 100 === 0) {
          process.stderr.write(`\r  ${read.toLocaleString("en-US")} documents…`);
        }

        yield document;
      }
    };

    const index = await buildIndex(documents());
    const builtMs = Date.now() - startedAt;

    //\x1b[K clears the rest of the line, so the progress counter's tail is not left behind
    //the shorter message that replaces it.
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    console.error(
      `Built ${index.terms.size.toLocaleString("en-US")} terms from ` +
        `${read.toLocaleString("en-US")} documents in ${(builtMs / 1000).toFixed(1)}s.`,
    );

    if (read === 0) {
      console.error(
        "\nNothing to index — the `documents` table is empty. Run `npm run crawl` first.",
      );
    }

    if (options.dryRun) {
      console.log(formatSummary(index, null, builtMs, Date.now() - startedAt));
      return EXIT_OK;
    }

    //A dedicated client, not the pool: BEGIN/COMMIT and COPY are both connection-scoped, and
    //`pool.query` is free to answer two calls on two different connections — which would put
    //the COPY outside the transaction that deleted the rows it replaces.
    const client = await pgPool.connect();

    let written: IndexWriteStats;
    try {
      console.error("Writing…");
      written = await writeIndex(client, index, { batchSize: options.writeBatchSize });
    } finally {
      client.release();
    }

    //Read back rather than reported from memory. It is the one assertion that the BIGINT
    //round trip actually survived — `total_tokens` goes out as a string and comes back as
    //one, and a summary printed from `index.stats` would look identical either way.
    const persisted = await readCorpusStats(pgPool);

    console.log(formatSummary(index, { written, persisted }, builtMs, Date.now() - startedAt));

    return EXIT_OK;
  } finally {
    //In a finally so a thrown build still releases the pool; without it the process hangs on
    //an open handle instead of reporting what went wrong.
    await closePg();
  }
}

interface WriteReport {
  written: IndexWriteStats;
  persisted: Awaited<ReturnType<typeof readCorpusStats>>;
}

//formatSummary — building the printable report
function formatSummary(
  index: BuiltIndex,
  report: WriteReport | null,
  builtMs: number,
  totalMs: number,
): string {
  //Counts the total number of postings across every term, by spreading the Map's values into an array and summing up each entry's posting-list length.
  const postings = [...index.terms.values()].reduce(
    (total, entry) => total + entry.postings.length,
    0,
  );

  const lines = [
    "",
    report === null
      ? `Dry run — nothing written. Built in ${(totalMs / 1000).toFixed(1)}s.`
      : `Index rebuilt in ${(totalMs / 1000).toFixed(1)}s ` +
        `(build ${(builtMs / 1000).toFixed(1)}s, write ${((totalMs - builtMs) / 1000).toFixed(1)}s)`,
    "",
    section("Index", [
      ["documents", index.stats.totalDocs],
      ["terms", index.terms.size],
      ["postings", postings],
      ["total tokens", index.stats.totalTokens],
      ["avg doc length", Math.round(index.stats.avgDocLen)],
    ]),
  ];

  if (report !== null) {
    lines.push(
      section("Written", [
        ["term rows", report.written.terms],
        ["posting rows", report.written.postings],
        ["token counts", report.written.documents],
      ]),
      section("corpus_stats (read back)", [
        ["total docs", report.persisted.totalDocs],
        ["total tokens", report.persisted.totalTokens],
        ["avg doc length", Math.round(report.persisted.avgDocLen)],
      ]),
    );
  }

  return lines.join("\n");
}

//section — small table formatter
function section(title: string, rows: readonly (readonly [string, number])[]): string {
  const width = Math.max(...rows.map(([label]) => label.length));

  const body = rows
    .map(([label, value]) => `  ${label.padEnd(width)}  ${value.toLocaleString("en-US")}`)
    .join("\n");

  return `${title}\n${body}\n`;
}

//Progress to stderr, summary to stdout — 1.7's split, so `npm run index > report.txt` leaves
//a clean artifact while the build is still watchable.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("index: failed —", error);
    process.exitCode = EXIT_ERROR;
  });
