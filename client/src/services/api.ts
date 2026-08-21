import type { SearchResponse, Statistics, Suggestion } from "shared";

/**
 * The typed edge of the client: one function per Phase 3 endpoint, over the same
 * `shared/` types the server built its response bodies from.
 *
 * Deliberately transport only — no caching, no debounce, no retry, no request
 * deduplication. All four are 4.3's, and TanStack Query does them better than a
 * hand-rolled layer underneath it would; a cache here would sit below the one that
 * actually gets invalidated and quietly serve stale pages to it. What this module owns is
 * URL construction, the non-2xx contract, and the cast at the JSON boundary.
 */

//Purpose: figure out, once, what prefix to put in front of every request path (e.g. /search becomes https://some-host/api/search).
//import.meta.env is Vite's mechanism for exposing environment variables to browser code.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/+$/, "");

/**
 * `status` on an error that never reached the server.
 *
 * A DNS failure, a dropped connection and a CORS rejection all surface as one opaque
 * `TypeError` from `fetch` with no status to report, and the UI has to say something
 * different about them than about a 500 — "check your connection", not "the server broke".
 * Zero is the sentinel because no HTTP status is zero.
 */
export const NETWORK_ERROR_STATUS = 0;

//Purpose: every possible failure this file can produce — network failure, HTTP error status, unreadable body 
// — gets funneled into this one error type, so any code calling into this file can write a single catch block and just check .status to decide what happened.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
}

//The shape of what you need to call search(): q (the query text) is required; page (which page of results, 1-based) and pageSize (results per page) are optional.
export interface SearchParams {
  q: string;
  /** 1-based. Omitted from the URL when undefined, so the server's default applies. */
  page?: number;
  pageSize?: number;
}

//Purpose: calls GET /search on the server and returns ranked search results for a query.
export function search(
  params: SearchParams,
  options: RequestOptions = {},
): Promise<SearchResponse> {
  //creates a URLSearchParams object — a built-in browser/Node API for building and reading URL query strings.
  const query = new URLSearchParams({ q: params.q });
  //The two if checks add page and pageSize only if they were actually provided —
  //converting them to strings with String(...) since URLSearchParams only stores string values, then omitting them entirely otherwise.
  if (params.page !== undefined) query.set("page", String(params.page));
  if (params.pageSize !== undefined) query.set("pageSize", String(params.pageSize));

  return request<SearchResponse>("/search", query, options);
}

//Purpose: calls GET /suggestions to get autocomplete suggestions as the user types.
export function fetchSuggestions(
  q: string,
  options: RequestOptions = {},
): Promise<Suggestion[]> {
  return request<Suggestion[]>("/suggestions", new URLSearchParams({ q }), options);
}

//Purpose: calls GET /statistics to get corpus-wide numbers (e.g. how many pages are indexed, when it was last updated).
//No parameters are needed for this endpoint, so it passes an empty URLSearchParams().
export function fetchStatistics(options: RequestOptions = {}): Promise<Statistics> {
  return request<Statistics>("/statistics", new URLSearchParams(), options);
}

/** A body that was not JSON at all, kept distinct from a body that was legitimately `null`. */
//Symbol(...) creates a value guaranteed to be unique — even calling
//Symbol("unparseable") twice produces two different values that will never equal each other or anything else. 
// It's used purely as an internal marker meaning "the response body was not valid JSON at all,
const UNPARSEABLE = Symbol("unparseable");


//Purpose: the one function all three public calls funnel through. It builds the final URL, performs the actual fetch(), 
// decides whether the response counts as success or failure, safely parses JSON, and returns a correctly-typed value — or throws a consistent ApiError.
async function request<T>(
  path: string,
  query: URLSearchParams,
  { signal }: RequestOptions,
): Promise<T> {
  //`[...query]` rather than `query.size`, which older Safari does not implement. An empty
  //`?` is harmless but makes `/statistics` requests read oddly in the network panel.
  const queryString = [...query].length > 0 ? `?${query}` : "";

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}${queryString}`, {
      signal,
      headers: { Accept: "application/json" },
    });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new ApiError(NETWORK_ERROR_STATUS, "Could not reach the search API.", { cause });
  }

  //The body is read and JSON-parsed regardless of success or failure — because if the response did fail (e.g. a 400), the useful explanation of why lives inside that JSON body, not in the HTTP status line.
  const body = await readJson(response, signal);

  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(body, response.status));
  }

  if (body === UNPARSEABLE) {
    throw new ApiError(response.status, "The search API returned an unreadable response.");
  }

//as T is a type assertion — it does nothing at runtime, it just tells TypeScript "trust me, treat this as type T
  return body as T;
}
//Purpose: safely attempt to parse a response body as JSON without throwing on non-JSON content, while still letting a genuine cancellation propagate correctly as a cancellation.
async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    //The body streams separately from the headers, so a cancellation can land here rather
    //than at `fetch` — and it still has to stay an abort rather than becoming an error.
    if (isAbortError(cause) || signal?.aborted) throw cause;
    return UNPARSEABLE;
  }
}

//Purpose: pull a human-readable message out of a failed response's JSON body, with a safe fallback if the body doesn't have the expected shape.
function errorMessage(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string" && error.length > 0) return error;
  }

  return `The search API failed with status ${status}.`;
}
//Purpose: reliably detect whether a caught error represents a cancelled fetch(), across different JavaScript environments.
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
