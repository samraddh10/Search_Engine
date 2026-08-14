//Node's built-in argument parser — takes raw argv and a schema of expected flags, hands back { values, positionals }.
import { parseArgs } from "node:util";
import { z } from "zod";
import { INDEX_STORE_DEFAULTS } from "./indexStore.js";

export interface IndexCliOptions {
  help: boolean;
  /** Build and report, but write nothing. */
  dryRun: boolean;
  readBatchSize: number;
  writeBatchSize: number;
}

/** A parse failure is returned, not thrown — same shape as 1.1's `FetchResult`. */
export type IndexArgsResult =
  | { ok: true; options: IndexCliOptions }
  | { ok: false; message: string };

export const USAGE = `Usage: npm run index [options]

Rebuilds the inverted index from every row in \`documents\`, replacing \`terms\`,
\`postings\` and \`corpus_stats\` in a single transaction. Readers keep serving the
previous index until it commits.

Options:
      --dry-run          Build the index and print the summary without writing.
      --read-batch <n>   Documents per read round trip. (default: ${INDEX_STORE_DEFAULTS.readBatchSize})
      --write-batch <n>  Rows per term/token-count statement. (default: ${INDEX_STORE_DEFAULTS.writeBatchSize})
  -h, --help             Show this message. npm intercepts this flag before the script
                         sees it, so run \`npm run index -- --help\` from Git Bash, or
                         accept that PowerShell strips the \`--\` separator.

This is a full rebuild, not an incremental update: \`doc_freq\` is a corpus-global
count, so it is only correct once every document has been read. Run it after a crawl.`;

const numbersSchema = z.object({
  //Bounds rather than bare coercion. Both knobs trade round trips against peak memory, and
  //neither has a value worth allowing at the extremes: a read batch of 100k pulls the whole
  //corpus's prose into one array, which is precisely what streaming exists to avoid.
  "read-batch": z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(INDEX_STORE_DEFAULTS.readBatchSize),
  "write-batch": z.coerce
    .number()
    .int()
    .positive()
    .max(50_000)
    .default(INDEX_STORE_DEFAULTS.writeBatchSize),
});

export function parseIndexArgs(argv: readonly string[]): IndexArgsResult {
  let values: Record<string, string | boolean | undefined>;

  try {
    //strict + allowPositionals: false, so a typo'd flag is an error instead of a silently
    //ignored argument — a rebuild that ran with defaults the user thought they overrode is
    //expensive to notice and expensive to repeat.
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "dry-run": { type: "boolean" },
        "read-batch": { type: "string" },
        "write-batch": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (values.help === true) return { ok: true, options: { ...DEFAULT_OPTIONS, help: true } };

  const numbers = numbersSchema.safeParse({
    "read-batch": values["read-batch"],
    "write-batch": values["write-batch"],
  });

  if (!numbers.success) {
    const details = numbers.error.issues
      .map((issue) => `--${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    return { ok: false, message: details };
  }

  return {
    ok: true,
    options: {
      help: false,
      dryRun: values["dry-run"] === true,
      readBatchSize: numbers.data["read-batch"],
      writeBatchSize: numbers.data["write-batch"],
    },
  };
}

const DEFAULT_OPTIONS: IndexCliOptions = {
  help: false,
  dryRun: false,
  readBatchSize: INDEX_STORE_DEFAULTS.readBatchSize,
  writeBatchSize: INDEX_STORE_DEFAULTS.writeBatchSize,
};
