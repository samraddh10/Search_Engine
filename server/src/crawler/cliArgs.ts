//Argument parsing, split out from cli.ts for one reason: it is the only part of 1.7 that
//can be tested without a network, a database or a Redis. The rest of the entry point is
//connection lifecycle and signal handling, which is untestable-without-infrastructure by
//definition — and `crawl()` itself is already covered by 1.5's suite.
//
//parseArgs (node:util) rather than commander/yargs, matching 1.1/1.2/1.4/1.5/1.6's
//no-new-dependency streak: flag parsing is not the kind of thing those phases bought a
//dependency for. But parseArgs hands back raw strings with no coercion, so `--max abc`
//would sail through as NaN and fail somewhere unhelpful — hence zod, already a dependency,
//used the same way config.ts uses it: validate untrusted external input at the boundary.
import { parseArgs } from "node:util";
import { z } from "zod";
import { FRONTIER_DEFAULTS } from "./frontier.js";
import { CRAWL_DEFAULTS } from "./scheduler.js";
import { parseHttpUrl } from "./url.js";

export interface CrawlCliOptions {
  help: boolean;
  seeds: string[];
  /** Extra allowed hosts, merged with the seeds' own hosts by the caller. */
  hosts: string[];
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  defaultCrawlDelayMs: number;
  fresh: boolean;
}

/**
 * A parse failure is *returned*, not thrown — same shape as 1.1's `FetchResult` and 1.4's
 * `AddResult`, and for the same reason: the caller decides what a bad flag costs (here,
 * usage text and exit 1), and a pure function is what makes the test suite infrastructure-free.
 */
export type CrawlArgsResult =
  | { ok: true; options: CrawlCliOptions }
  | { ok: false; message: string };

export const USAGE = `Usage: npm run crawl -- --seed <url> [options]

Options:
  -s, --seed <url>       Seed URL. Repeat the flag for several seeds. (required)
      --host <host>      Extra host to allow beyond the seeds' own. Repeatable.
  -m, --max <n>          Stop after N successful fetches. (default: ${CRAWL_DEFAULTS.maxPages})
  -d, --depth <n>        Maximum link depth from a seed. (default: ${FRONTIER_DEFAULTS.maxDepth})
  -c, --concurrency <n>  Maximum requests in flight. (default: ${CRAWL_DEFAULTS.concurrency})
      --delay <ms>       Per-host delay when robots.txt names none. (default: ${CRAWL_DEFAULTS.defaultCrawlDelayMs})
      --fresh            Clear the frontier first instead of resuming it.
  -h, --help             Show this message. npm intercepts this flag before the script
                         sees it, so run \`npm run crawl\` with no flags instead.

The frontier resumes by default. With REDIS_URL set it survives between runs, so
repeating the same command continues where the last one stopped; --fresh starts over.
Stored documents are unaffected either way — re-crawling updates rows, never duplicates
them.`;

//Bounds, not just types. An upper limit on --delay is the one that earns its keep: the
//delay applies to *every* request on a host, so a typo'd 60000 compounds across the whole
//crawl the same way 1.2 warned a typo'd Crawl-delay would.
const numbersSchema = z.object({
  max: z.coerce.number().int().positive().default(CRAWL_DEFAULTS.maxPages),
  depth: z.coerce.number().int().min(0).max(20).default(FRONTIER_DEFAULTS.maxDepth),
  concurrency: z.coerce.number().int().positive().max(64).default(CRAWL_DEFAULTS.concurrency),
  delay: z.coerce
    .number()
    .int()
    .min(0)
    .max(60_000)
    .default(CRAWL_DEFAULTS.defaultCrawlDelayMs),
});

export function parseCrawlArgs(argv: readonly string[]): CrawlArgsResult {
  let values: Record<string, string | string[] | boolean | undefined>;

  try {
    //strict + allowPositionals: false means a typo'd flag or a bare `npm run crawl <url>`
    //is an error rather than a silently ignored argument — the crawl would otherwise run
    //with defaults the user thought they had overridden.
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        seed: { type: "string", multiple: true, short: "s" },
        host: { type: "string", multiple: true },
        max: { type: "string", short: "m" },
        depth: { type: "string", short: "d" },
        concurrency: { type: "string", short: "c" },
        delay: { type: "string" },
        fresh: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  //--help is answered before anything else is validated: `npm run crawl -- --help` must
  //print usage, not "at least one --seed is required".
  if (values.help === true) return { ok: true, options: { ...EMPTY_OPTIONS, help: true } };

  const seeds = (values.seed as string[] | undefined) ?? [];
  if (seeds.length === 0) {
    return { ok: false, message: "at least one --seed is required" };
  }

  //Seeds are validated with parseHttpUrl, not zod's .url(), because the crawler's rule is
  //narrower than zod's: `ftp://` and `file://` are valid URLs and are not crawlable. Using
  //the same function the frontier uses means the CLI can never accept a seed that the
  //frontier would then silently reject as invalid-url.
  for (const seed of seeds) {
    if (!parseHttpUrl(seed)) {
      return { ok: false, message: `--seed is not a valid http(s) URL: ${seed}` };
    }
  }

  const numbers = numbersSchema.safeParse({
    max: values.max,
    depth: values.depth,
    concurrency: values.concurrency,
    delay: values.delay,
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
      seeds,
      hosts: normalizeHosts((values.host as string[] | undefined) ?? []),
      maxPages: numbers.data.max,
      maxDepth: numbers.data.depth,
      concurrency: numbers.data.concurrency,
      defaultCrawlDelayMs: numbers.data.delay,
      fresh: values.fresh === true,
    },
  };
}

//--host accepts either a bare hostname or a full URL. Pasting a URL is the likelier
//mistake and the correction is unambiguous, so making it an error would be pedantry.
//`Frontier` canonicalizes (lowercase, www stripped) on its own, so this only has to get
//the hostname out.
function normalizeHosts(hosts: readonly string[]): string[] {
  const out = new Set<string>();

  for (const host of hosts) {
    const parsed = parseHttpUrl(host);
    const value = parsed ? parsed.hostname : host.trim().toLowerCase();
    if (value) out.add(value);
  }

  return [...out];
}

const EMPTY_OPTIONS: CrawlCliOptions = {
  help: false,
  seeds: [],
  hosts: [],
  maxPages: CRAWL_DEFAULTS.maxPages,
  maxDepth: FRONTIER_DEFAULTS.maxDepth,
  concurrency: CRAWL_DEFAULTS.concurrency,
  defaultCrawlDelayMs: CRAWL_DEFAULTS.defaultCrawlDelayMs,
  fresh: false,
};
