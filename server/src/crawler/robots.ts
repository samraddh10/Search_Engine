//robots-parser — a third-party npm library that knows how to read robots.txt text and turn it into a queryable object.
import robotsParserModule from "robots-parser";
import { redisClient } from "../db/redis.js";
import { fetchPage, USER_AGENT_TOKEN, type FetchFailure } from "./fetcher.js";
import { parseHttpUrl } from "./url.js";

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}

const robotsParser = robotsParserModule as unknown as (
  url: string,
  contents: string,
) => Robot;

//When fetching robots.txt, only accept responses whose Content-Type is text/plain or blank/missing.
const ROBOTS_CONTENT_TYPES = ["text/plain", ""] as const;

export const ROBOTS_DEFAULTS = {
  maxBytes: 512 * 1024, // don't read more than 512KB of robots.txt
  timeoutMs: 5_000, // give up after 5 seconds
  maxAttempts: 2,
  rulesTtlMs: 24 * 60 * 60 * 1000,  // cache real rules for 24 hours
  unreachableTtlMs: 5 * 60 * 1000,  // cache "couldn't reach it" for only 5 minutes

  //maxCrawlDelayMs protects you from a robots.txt that says Crawl-delay: 999999
  maxCrawlDelayMs: 30_000, // never honor a crawl-delay longer than 30 seconds
} as const;

export type RobotsOutcome = "rules" | "allow-all" | "disallow-all";
//RobotsSource — this isn't about what the answer is, it's about where the answer came from
export type RobotsSource = "memory" | "redis" | "network";

//This is the public answer shape — what the rest of your crawler actually receives when it calls this module.
export interface RobotsDecision {
  allowed: boolean;
  crawlDelayMs?: number;
  sitemaps: readonly string[];
  outcome: RobotsOutcome;
  source: RobotsSource;
}

//very field is optional (?) — this lets a caller override any default from ROBOTS_DEFAULTS for a single call, without being forced to specify all of them.
export interface RobotsOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxAttempts?: number;
  maxBytes?: number;
  rulesTtlMs?: number;
  unreachableTtlMs?: number;
  maxCrawlDelayMs?: number;
}

//This is not exported — it's an internal, richer version of the decision, used only inside this file while working things out.
interface RobotsEntry {
  outcome: RobotsOutcome;
  rules: Robot | null;
  sitemaps: readonly string[];
  crawlDelayMs?: number;
  expiresAt: number;
}

//This is what actually gets written to Redis.
//RobotsEnvelope stores the raw text (text?: string), not the parsed Robot object,
//because Redis only stores strings and the parsed object can't survive being serialized.
//That means every time you read from Redis, you'll re-parse the text — a small, deliberate cost in exchange for something that's actually storable.
interface RobotsEnvelope {
  kind: RobotsOutcome;
  text?: string;
  expiresAt: number;
}
//memoryCache — the fastest possible cache: plain JS objects sitting in RAM, for the current process's lifetime. This is checked before even touching Redis.
const memoryCache = new Map<string, RobotsEntry>();

//inFlight — this is a deduplication mechanism, not really a "cache" in the normal sense.
//inFlight stores the in-progress Promise for a host's robots.txt lookup
//so if a second request comes in while the first is still loading,
//it just waits on the same promise instead of starting a duplicate fetch.
const inFlight = new Map<string, Promise<{ entry: RobotsEntry; source: RobotsSource }>>();

//checkRobots — the public entry point everyone calls
export async function checkRobots(
  rawUrl: string,
  options: RobotsOptions = {},
): Promise<RobotsDecision> {
  //Call a helper function (defined later in the file) that tries to turn the raw text rawUrl into a proper URL object
  const url = parseHttpUrl(rawUrl);
  if (!url) {
    return { allowed: false, sitemaps: [], outcome: "disallow-all", source: "network" };
  }

  //.origin is a built-in property on the URL object that gives you just the "scheme + host + port" part of a URL
  const origin = url.origin;

  //Call a helper  to check the fast in-RAM cache. If something valid was found (cached is truthy — not null), 
  // immediately compute the final answer via decide(...) and return it right away — source: "memory" because 
  // that's where we got the data from. This is the fastest possible path through the whole function.
  const cached = readMemory(origin);
  if (cached) return decide(url, cached, "memory");

  //If we get here, memory didn't have an answer. inFlight.get(origin) tries to find an already-in-progress load for this website.
  //?? is the nullish coalescing operator. A ?? B means: "use A, unless A is null or undefined
  const pending = inFlight.get(origin) ?? startLoad(origin, options);
  const { entry, source } = await pending;
  //Finally, decide(url, entry, source) computes the actual final answer for this specific URL
  return decide(url, entry, source);
}

//A reset helper
export function clearRobotsCache(): void {
  memoryCache.clear();
  inFlight.clear();
}

//Starting and running a "load" (the cache-miss path)
function startLoad(
  origin: string,
  options: RobotsOptions,
): Promise<{ entry: RobotsEntry; source: RobotsSource }> {
  const pending = loadEntry(origin, options).finally(() => inFlight.delete(origin));
  inFlight.set(origin, pending);
  return pending;
}

//loadEntry — the "go figure out the answer" function
async function loadEntry(
  origin: string,
  options: RobotsOptions,
): Promise<{ entry: RobotsEntry; source: RobotsSource }> {
  const maxCrawlDelayMs = options.maxCrawlDelayMs ?? ROBOTS_DEFAULTS.maxCrawlDelayMs;

  //Scenario A — Redis already has something. Say readRedis("https://shop.example.com") comes back with:
  /*
  That's stored. Since it's not null/falsy, if (stored) is true. We hand this off to buildEntry (which will parse that text into real rules — 
  covered below), save the result into memoryCache so the next call skips Redis entirely, and immediately return { entry, source: "redis" }. 
  Function ends here — nothing below this block runs in this scenario.
  */
  const stored = await readRedis(origin);
  if (stored) {
    const entry = buildEntry(origin, stored, maxCrawlDelayMs);
    memoryCache.set(origin, entry);
    return { entry, source: "redis" };
  }

  //Scenario B — Redis had nothing (stored was null)
  /*
  Now we actually go fetch it live: fetchRobots(origin, options). Say the crawler was shutting down mid-request and this fetch got cancelled — 
  fetchRobots reports that as null (you'll see why below). if (!fetched) is true, 
  so we return a throwaway answer: block everything (disallow-all) but with expiresAt: 0, which 
  — since 0 is always less-than-or-equal to Date.now() 
  — means "this is already considered expired, don't trust it as a real cached fact, it was just a safe guess for this one call."
  */
  const fetched = await fetchRobots(origin, options);

  if (!fetched) {
    return {
      entry: { outcome: "disallow-all", rules: null, sitemaps: [], expiresAt: 0 },
      source: "network",
    };
  }

  //Scenario C — the fetch actually succeeded (or failed in a meaningful way, like a 404). Say fetched comes back as:
  /*
  Build the real entry from it, save to memoryCache (fast future lookups), also save it to Redis via writeRedis 
  (so it survives even if your program restarts tomorrow), then return it, labeled source: "network" since this is where the data genuinely came from.
  */
  const entry = buildEntry(origin, fetched, maxCrawlDelayMs);
  memoryCache.set(origin, entry);
  await writeRedis(origin, fetched);
  return { entry, source: "network" };
}


//fetchRobots — actually going out to the website
async function fetchRobots(
  origin: string,
  options: RobotsOptions,
): Promise<RobotsEnvelope | null> {
  const rulesTtlMs = options.rulesTtlMs ?? ROBOTS_DEFAULTS.rulesTtlMs;
  const unreachableTtlMs = options.unreachableTtlMs ?? ROBOTS_DEFAULTS.unreachableTtlMs;

  //This actually calls fetchPage("https://shop.example.com/robots.txt", {...settings...}) 
  // — the function from the fetcher file, going out over the real internet.
  const result = await fetchPage(`${origin}/robots.txt`, {
    timeoutMs: options.timeoutMs ?? ROBOTS_DEFAULTS.timeoutMs,
    maxAttempts: options.maxAttempts ?? ROBOTS_DEFAULTS.maxAttempts,
    maxBytes: options.maxBytes ?? ROBOTS_DEFAULTS.maxBytes,
    allowedContentTypes: ROBOTS_CONTENT_TYPES,
    signal: options.signal,
  });

  //Success
  if (result.ok) {
    return { kind: "rules", text: result.body, expiresAt: Date.now() + rulesTtlMs };
  }

  //failure
  const kind = outcomeForFailure(result);
  if (!kind) return null;

  const ttlMs = kind === "disallow-all" ? unreachableTtlMs : rulesTtlMs;
  return { kind, expiresAt: Date.now() + ttlMs };
}

//Case 3 — aborted. If the fetch was cancelled (reason: "aborted"), outcomeForFailure returns null
function outcomeForFailure(failure: FetchFailure): RobotsOutcome | null {
  if (failure.reason === "aborted") return null;

  if (failure.reason === "too-large") return "disallow-all";

  return failure.retryable ? "disallow-all" : "allow-all";
}

//buildEntry — turning stored/fetched raw data into something with a working .isAllowed() method
function buildEntry(
  origin: string,
  envelope: RobotsEnvelope,
  maxCrawlDelayMs: number,
): RobotsEntry {
  if (envelope.kind !== "rules" || envelope.text === undefined) {
    return { outcome: envelope.kind, rules: null, sitemaps: [], expiresAt: envelope.expiresAt };
  }

  //No parsing needed at all — there was never any real robots.txt text to parse.
  const rules = robotsParser(`${origin}/robots.txt`, envelope.text);
  return {
    outcome: "rules",
    rules,
    sitemaps: rules.getSitemaps(),
    crawlDelayMs: crawlDelayMsFrom(rules, maxCrawlDelayMs),
    expiresAt: envelope.expiresAt,
  };
}

//decide — answering for one exact URL
function decide(url: URL, entry: RobotsEntry, source: RobotsSource): RobotsDecision {
  let allowed: boolean;
  if (entry.outcome === "allow-all") {
    allowed = true;
  } else if (entry.outcome === "disallow-all") {
    allowed = false;
  } else {
    allowed = entry.rules?.isAllowed(url.href, USER_AGENT_TOKEN) ?? true;
  }

  return {
    allowed,
    crawlDelayMs: entry.crawlDelayMs,
    sitemaps: entry.sitemaps,
    outcome: entry.outcome,
    source,
  };
}

//This function's job: figure out how long to wait between requests to a website, in milliseconds 
// — but never let it be longer than our safety cap.
function crawlDelayMsFrom(rules: Robot, maxCrawlDelayMs: number): number | undefined {
  const seconds = rules.getCrawlDelay(USER_AGENT_TOKEN);
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;

  return Math.min(seconds * 1000, maxCrawlDelayMs);
}

function readMemory(origin: string): RobotsEntry | null {
  const entry = memoryCache.get(origin);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(origin);
    return null;
  }

  return entry;
}

//This function's job: check the fast, in-memory "notebook" cache to see if we already have fresh robots.txt rules for this website 
// — and if the rules we find are too old, throw them away instead of using them.
async function readRedis(origin: string): Promise<RobotsEnvelope | null> {
  if (!redisClient) return null;

  try {
    const raw = await redisClient.get(cacheKey(origin));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!isEnvelope(parsed)) return null;
    if (parsed.expiresAt <= Date.now()) return null;

    return parsed;
  } catch {
    return null;
  }
}

//This function's job: save a robots.txt answer into Redis (the shared, persistent filing cabinet), so that even if your crawler restarts later, 
// it doesn't have to re-fetch this website's rules from scratch.
async function writeRedis(origin: string, envelope: RobotsEnvelope): Promise<void> {
  if (!redisClient) return;

  const ttlMs = Math.ceil(envelope.expiresAt - Date.now());
  if (ttlMs <= 0) return;

  try {
    await redisClient.set(cacheKey(origin), JSON.stringify(envelope), "PX", ttlMs);
  } catch (error) {
    console.warn("robots: failed to cache in Redis", error);
  }
}

//This is the simplest function in the whole file — it's a tiny helper whose only job is: 
// build the exact text string used as the "label" on a Redis storage box, for a given website.
function cacheKey(origin: string): string {
  return `robots:${origin}`;
}

//This function's job: act as a "bouncer" that checks whether some untrusted data — just pulled out of Redis and parsed from JSON — is actually safe to treat as a real RobotsEnvelope,
//  before the rest of the code trusts it.
function isEnvelope(value: unknown): value is RobotsEnvelope {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Partial<RobotsEnvelope>;
  const kindOk =
    candidate.kind === "rules" ||
    candidate.kind === "allow-all" ||
    candidate.kind === "disallow-all";

  return (
    kindOk &&
    typeof candidate.expiresAt === "number" &&
    (candidate.kind !== "rules" || typeof candidate.text === "string")
  );
}

//The local parseHttpUrl that used to live here moved to crawler/url.ts in 1.3, where the
//parser and the 1.4 frontier need the same check. Imported rather than duplicated.
