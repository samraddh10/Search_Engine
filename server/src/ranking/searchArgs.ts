// it is the only part of the CLI testable without infrastructure,
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

/** A parse failure is returned, not thrown — same shape as `FetchResult`. */
export type SearchArgsResult =
  | { ok: true; options: SearchCliOptions }
  | { ok: false; message: string };

  //: the help text printed when --help/-h is passed, or presumably when parsing fails. Just a template string — no logic to walk through
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
  limit: z.coerce.number().int().positive().max(1_000).default(SEARCH_DEFAULTS.limit),
  k1: z.coerce.number().nonnegative().max(1_000).default(BM25_DEFAULTS.k1),
  b: z.coerce.number().min(0).max(1).default(BM25_DEFAULTS.b),
});

//Purpose of this function: the main entry point — takes the raw argv array (command-line arguments) and returns either a fully validated SearchCliOptions object or a descriptive error message, never throwing.
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

  //positionals is an array of every bare word typed after the flags (Node's parseArgs splits on whitespace, so an unquoted multi-word query arrives as separate array elements). 
  // .join(" ") glues them back into one string with single spaces between them; .trim() strips any leading/trailing whitespace.
  const query = positionals.join(" ").trim();

  //If no positional arguments were given at all (or they were all whitespace), fail clearly rather than let an empty-string query silently proceed into processQuery and produce a nonsensical "search for nothing" result.
  if (query === "") {
    return { ok: false, message: "a query is required" };
  }

  //.safeParse(...) (as opposed to plain .parse(...)) is zod's non-throwing validation method
  //it returns a result object ({ success: true, data } or { success: false, error }) instead of throwing on failure
  const numbers = numbersSchema.safeParse({
    limit: values.limit,
    k1: values.k1,
    b: values.b,
  });

  //If any of the three numbers failed validation (e.g., --b 5 violates .max(1)), zod's numbers.error.issues
  if (!numbers.success) {
    const details = numbers.error.issues
    //.map(...) formats each issue into a readable line like --b: Number must be less than or equal to 1, using issue.path.join(".")
      .map((issue) => `--${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    return { ok: false, message: details };
  }

  //The success path:
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
//Purpose: a complete, fully-formed fallback SearchCliOptions object, used only in the --help short-circuit branch above
const DEFAULT_OPTIONS: SearchCliOptions = {
  help: false,
  query: "",
  limit: SEARCH_DEFAULTS.limit,
  k1: BM25_DEFAULTS.k1,
  b: BM25_DEFAULTS.b,
  explain: false,
};
