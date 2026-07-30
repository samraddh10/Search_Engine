//sent on every request so site owners can identify the bot
const USER_AGENT ="SearchEngine2Bot/0.1 (+https://github.com/search-engine2; educational crawler)";

const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const FETCH_DEFAULTS = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  maxRetryAfterMs: 30_000,
} as const;

//Every field is optional (?), this ? is the reason
export interface FetchOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  maxBytes?: number;
  maxRedirects?: number;
  baseBackoffMs?: number;
  signal?: AbortSignal;
}

//type (with the | symbol) can describe a union — "this value is one of several options.
// " That's a completely different kind of description, and interface simply can't express it.
export type FetchFailureReason =
  | "invalid-url"
  | "timeout"
  | "network"
  | "http-error"
  | "too-many-redirects"
  | "too-large"
  | "unsupported-content-type"
  | "aborted";

  //interface describes the shape of an object 
  // — a thing with named properties, like { ok: true, status: 200, body: "..." }
export interface FetchSuccess {
  ok: true;
  requestedUrl: string;
  url: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  attempts: number;
  elapsedMs: number;
}

export interface FetchFailure {
  ok: false;
  requestedUrl: string;
  url: string;
  reason: FetchFailureReason;
  retryable: boolean;
  status?: number;
  message: string;
  attempts: number;
  elapsedMs: number;
}

export type FetchResult = FetchSuccess | FetchFailure;

//AttemptOutcome (defined right after) is a near-identical internal-only version of this same union,
// used by the helper functions before they're assembled into the final FetchResult
type AttemptOutcome =
  | {
      ok: true;
      url: string;
      status: number;
      contentType: string;
      body: string;
      bytes: number;
    }
  | {
      ok: false;
      url: string;
      reason: FetchFailureReason;
      retryable: boolean;
      status?: number;
      message: string;
      retryAfterMs?: number;
    };

export async function fetchPage(
  requestedUrl: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const {
    timeoutMs = FETCH_DEFAULTS.timeoutMs,
    maxAttempts = FETCH_DEFAULTS.maxAttempts,
    maxBytes = FETCH_DEFAULTS.maxBytes,
    maxRedirects = FETCH_DEFAULTS.maxRedirects,
    baseBackoffMs = FETCH_DEFAULTS.baseBackoffMs,
    signal,
  } = options;

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  const target = parseCrawlableUrl(requestedUrl);
  if (!target) {
    return {
      ok: false,
      requestedUrl,
      url: requestedUrl,
      reason: "invalid-url",
      retryable: false,
      message: "Not an absolute http(s) URL",
      attempts: 0,
      elapsedMs: elapsed(),
    };
  }

  //Then the retry loop: thsi is till await sleep(waitMs)
  let attempts = 0;

  //for (;;) — an infinite loop 
  // (loops forever until something inside it explicitly stops it with return or break)
  for (;;) {
    attempts += 1;

    const outcome = await attemptFetch(target, {
      timeoutMs,
      maxBytes,
      maxRedirects,
      signal,
    });

    if (outcome.ok) {
      return {
        ok: true,
        requestedUrl,
        url: outcome.url,
        status: outcome.status,
        contentType: outcome.contentType,
        body: outcome.body,
        bytes: outcome.bytes,
        attempts,
        elapsedMs: elapsed(),
      };
    }

    const waitMs = retryDelayMs(outcome, attempts, baseBackoffMs);
    const giveUp = !outcome.retryable || attempts >= maxAttempts || waitMs === null;

    if (giveUp) {
      return {
        ok: false,
        requestedUrl,
        url: outcome.url,
        reason: outcome.reason,
        retryable: outcome.retryable,
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
        message: outcome.message,
        attempts,
        elapsedMs: elapsed(),
      };
    }

    await sleep(waitMs);
  }
}

async function attemptFetch(
  target: URL,
  opts: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    signal: AbortSignal | undefined;
  },
): Promise<AttemptOutcome> {

  //Setting up the "give up" signal
  //AbortSignal — a built-in JavaScript object used to say "stop this operation.
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal
  //AbortSignal.any([...]) — combines multiple cancel signals into one. 
  // It fires ("cancels") the moment any one of the signals it's watching fires.
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  //The redirect-following loop
  let current = target;
  let redirects = 0;

  //for (;;) — an infinite loop 
  // (loops forever until something inside it explicitly stops it with return or break)
  for (;;) {

    //Making the actual HTTP request
    let response: Response;
    try {
    //fetch(...) — the built-in browser/Node function that actually sends the HTTP request 
    // over the internet and waits for a response.
      response = await fetch(current, {
        redirect: "manual",
        signal,
        headers: {
          "user-agent": USER_AGENT,
        //accept tells the server what kind of content we prefer back (mainly HTML), 
        // with q=0.9 and q=0.1 being "quality" preference weights
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
      });
    } catch (error) {
    //describeFetchError to turn it into a proper typed failure.
      return describeFetchError(error, current, opts.signal);
    }

  //Handling a redirect response
    if (REDIRECT_STATUSES.has(response.status)) {
    //discardBody(response) — throws away the response's body content since we don't need it for a redirect 
    //(explained in detail later — it's a cleanup helper).
      await discardBody(response);

    //response.headers.get("location") — redirects work by the server sending a Location header saying 
    // "go here instead." This reads that header's value.
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          url: current.href,
          reason: "http-error",
          retryable: false,
          status: response.status,
          message: `Redirect ${response.status} without a Location header`,
        };
      }

      redirects += 1;
      if (redirects > opts.maxRedirects) {
        return {
          ok: false,
          url: current.href,
          reason: "too-many-redirects",
          retryable: false,
          message: `Exceeded ${opts.maxRedirects} redirects`,
        };
      }

    //parseCrawlableUrl(location, current) — takes the redirect target 
    // and turns it into a proper, validated URL
      const next = parseCrawlableUrl(location, current);
      if (!next) {
        return {
          ok: false,
          url: current.href,
          reason: "invalid-url",
          retryable: false,
          message: `Redirect to an unusable location: ${location}`,
        };
      }

      current = next;
      continue;
    }

  //Handling a non-redirect error status
    if (!response.ok) {
      await discardBody(response);

      const retryable = isRetryableStatus(response.status);
      return {
        ok: false,
        url: current.href,
        reason: "http-error",
        retryable,
        status: response.status,
        message: `HTTP ${response.status}`,
        //The spread trick again: ...(retryable ? { retryAfterMs: ... } : {}) — 
        // if the error is retryable, also grab the Retry-After header (a hint from the server about how long to wait before trying again)
        //  and include it; if not retryable, add nothing extra.
        ...(retryable
          ? { retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) }
          : {}),
      };
    }

  //The three safety guards, once we get a good response
  //Guard 1 — is it actually HTML?
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!HTML_CONTENT_TYPES.has(contentType)) {
      await discardBody(response);
      return {
        ok: false,
        url: current.href,
        reason: "unsupported-content-type",
        retryable: false,
        message: `Unsupported content type: ${contentType || "(none)"}`,
      };
    }

  //Guard 2 (early check) — is it obviously too big?
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      await discardBody(response);
      return {
        ok: false,
        url: current.href,
        reason: "too-large",
        retryable: false,
        message: `Content-Length ${declared} exceeds ${opts.maxBytes} bytes`,
      };
    }

  //Guard 2 (real check) — actually enforce the size limit while downloading.

  //Uint8Array — an array specifically for holding raw bytes (numbers from 0–255), 
  // used here to hold the downloaded data before it's turned into readable text.
    let bytes: Uint8Array;
    try {
    //If readCapped reports "too-large",
      const read = await readCapped(response, opts.maxBytes);
      if (read === "too-large") {
        return {
          ok: false,
          url: current.href,
          reason: "too-large",
          retryable: false,
          message: `Body exceeds ${opts.maxBytes} bytes`,
        };
      }
      bytes = read;
    } catch (error) {
      return describeFetchError(error, current, opts.signal);
    }

    return {
      ok: true,
    //current.href — the full text of the final URL (after all redirects)
   //.href gets its string form.
      url: current.href,
      status: response.status,
      contentType,
    //new TextDecoder("utf-8").decode(bytes) — the downloaded data (bytes) is currently raw numbers, not readable text. 
    // TextDecoder converts those raw bytes into an actual JavaScript string, assuming UTF-8 encoding
      body: new TextDecoder("utf-8").decode(bytes),
      bytes: bytes.byteLength,
    };
  }
}

//readCapped — download the body, but stop if it gets too big
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | "too-large"> {
  if (!response.body) return new Uint8Array(0);

//getReader() — gets a tool for reading the stream piece by piece.
//chunks — an array to collect each piece of data as it arrives.
//total — running count of how many bytes we've received so far.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
  //reader.read() — asks for the next chunk of data. It returns an object with done (a boolean: true once there's no more data)
  // and value (the actual chunk of bytes, if any).
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "too-large";
    }

    chunks.push(value);
  }

//If we finished reading successfully, we now have a bunch of separate small chunks that need to be combined into one continuous array:
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
  //out.set(chunk, offset) — copies this chunk's bytes into the big array, starting at position offset.
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

//describeFetchError — turn a crash into a proper typed failure
function describeFetchError(
  error: unknown,
  url: URL,
  externalSignal: AbortSignal | undefined,
): AttemptOutcome {
  if (externalSignal?.aborted) {
    return {
      ok: false,
      url: url.href,
      reason: "aborted",
      retryable: false,
      message: "Cancelled by caller",
    };
  }

//error instanceof Error — checks whether error is actually a proper JavaScript Error object
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return {
      ok: false,
      url: url.href,
      reason: "timeout",
      retryable: true,
      message: "Request timed out",
    };
  }

//Anything else — DNS failure (couldn't even find the server), connection refused, connection reset 
// — gets classified as a generic "network" failure
  return {
    ok: false,
    url: url.href,
    reason: "network",
    retryable: true,
    message: error instanceof Error ? error.message : String(error),
  };
}

//retryDelayMs — how long to wait before trying again
function retryDelayMs(
  outcome: Extract<AttemptOutcome, { ok: false }>,
  attempt: number,
  baseBackoffMs: number,
): number | null {
  if (outcome.retryAfterMs !== undefined) {
    return outcome.retryAfterMs > FETCH_DEFAULTS.maxRetryAfterMs
      ? null
      : outcome.retryAfterMs;
  }

//Otherwise, calculate a wait time ourselves:
  const capped = Math.min(baseBackoffMs * 2 ** (attempt - 1), FETCH_DEFAULTS.maxBackoffMs);
  return capped / 2 + Math.random() * (capped / 2);
}

//isRetryableStatus — is this HTTP error worth retrying?
function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && status !== 501;
}

//parseRetryAfter — read the server's suggested wait time
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, date - Date.now());
}

//normalizeContentType — clean up the Content-Type header
function normalizeContentType(header: string | null): string {
  if (!header) return "";
  return header.split(";", 1)[0].trim().toLowerCase();
}

//parseCrawlableUrl — safely build and validate a URL
function parseCrawlableUrl(value: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  return url;
}

//Promise<void> — a promise that doesn't resolve to any meaningful value
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    //ignore
  }
}

function sleep(ms: number): Promise<void> {
  //setTimeout(callback, ms) — a built-in JavaScript function that runs callback after waiting ms milliseconds.
  //new Promise((resolve) => ...) — creates a promise manually. resolve is a function that, when called, marks 
  // the promise as "successfully finished."
  return new Promise((resolve) => setTimeout(resolve, ms));
}
