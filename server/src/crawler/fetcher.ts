//The bare product token. robots.txt groups are written `User-agent: SearchEngine2Bot`, and
//matching happens on that token alone — the full header below would never match one. The
//header is *built* from the token so the two can't drift apart; exported because robots.ts
//needs the token and duplicating the string there is how they'd silently disagree.
export const USER_AGENT_TOKEN = "SearchEngine2Bot";

//sent on every request so site owners can identify the bot
export const USER_AGENT =
  `${USER_AGENT_TOKEN}/0.1 (+https://github.com/search-engine2; educational crawler)`;

//The default allowlist — what a *page* fetch accepts. Overridable per call (see
//FetchOptions.allowedContentTypes) because robots.txt is text/plain, and a plain-text file
//carries none of the "arbitrary binary reaching the Phase 2 tokenizer" risk that motivated
//this guard for pages.
export const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"] as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const FETCH_DEFAULTS = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  maxRetryAfterMs: 30_000,
  allowedContentTypes: HTML_CONTENT_TYPES,
} as const;

//Every field is optional (?), this ? is the reason
export interface FetchOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  maxBytes?: number;
  maxRedirects?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetryAfterMs?: number;
  //Normalized (lowercase, no ";charset=...") content types this call will accept. An empty
  //string in the list means "accept a response that declared no Content-Type at all".
  allowedContentTypes?: readonly string[];
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
  //How long the server asked us to wait, when it said so (Retry-After on a 429/5xx).
  //Surfaced rather than swallowed: fetchPage refuses to block for a Retry-After longer
  //than maxRetryAfterMs, so without this field the caller would see retryable: true and
  //immediately re-hit a host that explicitly asked for an hour.
  retryAfterMs?: number;
  attempts: number;
  elapsedMs: number;
}

export type FetchResult = FetchSuccess | FetchFailure;

//AttemptOutcome is the internal-only version of the same union — what one attempt produced
// before the retry loop stamps on the fields only it can know (which URL was originally
// requested, how many attempts it took, how long the whole call ran). Derived with Omit
// rather than written out again, so a field added to FetchResult can't be silently
// forgotten here.
type AttemptOutcome =
  | ({ ok: true } & Omit<FetchSuccess, "ok" | "requestedUrl" | "attempts" | "elapsedMs">)
  | ({ ok: false } & Omit<FetchFailure, "ok" | "requestedUrl" | "attempts" | "elapsedMs">);

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
    maxBackoffMs = FETCH_DEFAULTS.maxBackoffMs,
    maxRetryAfterMs = FETCH_DEFAULTS.maxRetryAfterMs,
    allowedContentTypes = FETCH_DEFAULTS.allowedContentTypes,
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
      allowedContentTypes,
      signal,
    });

    //The attempt already carries every field that describes *what happened*; the loop only
    //adds what it alone knows. Spreading beats copying field by field — a new field on
    //FetchResult flows through without another edit here.
    if (outcome.ok) {
      return { ...outcome, requestedUrl, attempts, elapsedMs: elapsed() };
    }

    //Computed only when a retry is actually on the table, so a dead URL doesn't pay for a
    //backoff calculation whose answer gets discarded.
    const outOfAttempts = !outcome.retryable || attempts >= maxAttempts;
    const waitMs = outOfAttempts
      ? null
      : retryDelayMs(outcome, attempts, { baseBackoffMs, maxBackoffMs, maxRetryAfterMs });

    //waitMs === null also covers "the server asked for longer than we're willing to wait" —
    //outcome.retryAfterMs rides along in the spread so the caller can schedule it properly.
    if (outOfAttempts || waitMs === null) {
      return { ...outcome, requestedUrl, attempts, elapsedMs: elapsed() };
    }

    await sleep(waitMs, signal);
  }
}

async function attemptFetch(
  target: URL,
  opts: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    allowedContentTypes: readonly string[];
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
        //Retry-After is a hint from the server about how long to wait. Only meaningful when
        //the status is one we'd retry at all, so a 404 doesn't carry a wait time.
        retryAfterMs: retryable
          ? parseRetryAfter(response.headers.get("retry-after"))
          : undefined,
      };
    }

  //The three safety guards, once we get a good response
  //Guard 1 — is it a content type this call asked for? (HTML for pages, text/plain for robots.txt)
  //A plain array `includes` rather than a Set: the list is one or two entries, so building a
  //Set per call would cost more than the scan it replaces.
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!opts.allowedContentTypes.includes(contentType)) {
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
  //Kept as one object rather than destructured: the result is a discriminated union, so
  //`chunk.done` narrows `chunk.value` to a real Uint8Array and no undefined check is needed.
    const chunk = await reader.read();
    if (chunk.done) break;

    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return "too-large";
    }

    chunks.push(chunk.value);
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

//retryDelayMs — how long to wait before trying again, or null to stop trying
function retryDelayMs(
  outcome: Extract<AttemptOutcome, { ok: false }>,
  attempt: number,
  limits: { baseBackoffMs: number; maxBackoffMs: number; maxRetryAfterMs: number },
): number | null {
  if (outcome.retryAfterMs !== undefined) {
    return outcome.retryAfterMs > limits.maxRetryAfterMs ? null : outcome.retryAfterMs;
  }

//Otherwise, calculate a wait time ourselves:
  const capped = Math.min(
    limits.baseBackoffMs * 2 ** (attempt - 1),
    limits.maxBackoffMs,
  );
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
    //An undefined base behaves exactly like passing no base at all, so this one call covers
    //both the initial URL and a relative Location header.
    url = new URL(value, base);
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

//sleep — the pause between retry attempts, abandoned early if the caller cancels.
//Without the signal a shutdown would still have to wait out the full backoff (up to
//maxBackoffMs) before the next attempt could notice it was cancelled — so Ctrl-C in the
//1.7 CLI would appear to hang. Resolving early rather than rejecting keeps the caller
//simple: the next attempt sees the aborted signal and reports "aborted" itself.
//The timer is deliberately *not* unref'd — an unref'd backoff would let a process whose
//only pending work is this sleep exit silently, leaving the fetch unresolved.
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  //new Promise((resolve) => ...) — creates a promise manually. resolve is a function that,
  // when called, marks the promise as "successfully finished."
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    //setTimeout(callback, ms) — a built-in JavaScript function that runs callback after waiting ms milliseconds.
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
