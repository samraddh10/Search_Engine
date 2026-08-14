//Phase 2.4's flag parsing, split into its own module for the same reason 1.7 split `cliArgs.ts`
//and 2.3 split `indexArgs.ts`: it is the only part of the CLI testable without infrastructure,
//the rest being connection lifecycle and output formatting.
import { parseArgs } from "node:util";
import { z } from "zod";
import { BM25_DEFAULTS } from "./bm25.js";

export const SEARCH_DEFAULTS = {
  limit: 10,
} as const;

export interface SearchCliOptions {
  help: boolean;
  /** The raw query, before `processQuery` touches it. */
  query: string;
  limit: number;
  k1: number;
  b: number;
  /** Print per-term document frequency, IDF and match counts alongside the results. */
  explain: boolean;
}

/** A parse failure is returned, not thrown — same shape as 1.1's `FetchResult`. */
export type SearchArgsResult =
  | { ok: true; options: SearchCliOptions }
  | { ok: false; message: string };

export const USAGE = `Usage: npm run search -- "<query>" [options]

Ranks the indexed corpus against a query with BM25 and prints the top results.
A debug entry point for Phase 2.4 — the API in Phase 3 is the real consumer.

Options:
      --limit <n>   Results to print. (default: ${SEARCH_DEFAULTS.limit})
      --k1 <n>      Term-frequency saturation. (default: ${BM25_DEFAULTS.k1})
      --b <n>       Length normalization, 0 to 1. (default: ${BM25_DEFAULTS.b})
      --explain     Show each query term's stem, doc_freq, IDF and match count.
  -h, --help        Show this message. npm intercepts this flag before the script
                    sees it, so run \`npm run search -- --help\` from Git Bash.

The query runs through the same pipeline the indexer used, so it is stemmed and
stopword-filtered before lookup — "the crawlers" and "crawling" find the same rows.
Requires an index: run \`npm run crawl\` then \`npm run index\` first.

Windows note: PowerShell strips the \`--\` separator, so npm eats the flags as its
own config. Use Git Bash, or PowerShell's \`--%\` stop-parsing token.`;

const numbersSchema = z.object({
  //Bounded rather than merely coerced, exactly as 2.3 bounds its batch sizes. `parseArgs`
  //alone would let `--limit abc` through as NaN, which would slice nothing off the result
  //list and look like an empty corpus.
  limit: z.coerce.number().int().positive().max(1_000).default(SEARCH_DEFAULTS.limit),
  //`k1` is unbounded above in principle — the formula converges rather than breaks — but a
  //negative one inverts saturation so that repeating a word *lowers* the score, which is not
  //a knob anyone wants to turn by accident.
  k1: z.coerce.number().nonnegative().max(1_000).default(BM25_DEFAULTS.k1),
  //`b` outside 0..1 is not a stronger version of length normalization, it is a different and
  //incoherent function: above 1 a short document's norm goes negative.
  b: z.coerce.number().min(0).max(1).default(BM25_DEFAULTS.b),
});

export function parseSearchArgs(argv: readonly string[]): SearchArgsResult {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];

  try {
    //`allowPositionals: true`, unlike 2.3 — the query *is* a positional. Still `strict`, so a
    //typo'd flag is an error rather than a silently ignored argument.
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        limit: { type: "string" },
        k1: { type: "string" },
        b: { type: "string" },
        explain: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (values.help === true) return { ok: true, options: { ...DEFAULT_OPTIONS, help: true } };

  //Joined rather than requiring exactly one, so an unquoted `npm run search -- web crawler`
  //means what the user obviously intended instead of erroring on the second word.
  const query = positionals.join(" ").trim();

  if (query === "") {
    return { ok: false, message: "a query is required" };
  }

  const numbers = numbersSchema.safeParse({
    limit: values.limit,
    k1: values.k1,
    b: values.b,
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
      query,
      limit: numbers.data.limit,
      k1: numbers.data.k1,
      b: numbers.data.b,
      explain: values.explain === true,
    },
  };
}

const DEFAULT_OPTIONS: SearchCliOptions = {
  help: false,
  query: "",
  limit: SEARCH_DEFAULTS.limit,
  k1: BM25_DEFAULTS.k1,
  b: BM25_DEFAULTS.b,
  explain: false,
};
