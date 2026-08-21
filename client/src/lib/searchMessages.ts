import type { SearchResponse } from "shared";
import { NETWORK_ERROR_STATUS, type ApiError } from "../services/api.ts";

/**
 * The words the app says about a search that produced no results, in one place.
 *
 * They live outside the components that render them because `SearchPage`'s live region
 * announces them too: what a screen reader hears has to be what the page displays, and two
 * copies of a sentence is how they stop being the same sentence. Keeping them here rather
 * than exporting them from the components also keeps those files exporting components only,
 * which is what Vite's fast refresh needs in order to hot-swap them.
 *
 * Same placement as `splitSnippet` — a pure function over the API's own types, testable with
 * string literals and no DOM.
 */

/** The four reasons a result list can be empty, as one sentence. */
export function emptyResultsHeading(response: SearchResponse): string {
  if (response.status === "empty-index") return "Nothing is indexed yet.";
  if (response.status === "no-searchable-terms") return "That query is all stopwords.";
  if (response.total === 0) return `No documents match ${quote(response.query)}.`;

  //Not a status: a real result set, asked for past its last page.
  return `Page ${response.page} is past the end.`;
}

export interface ErrorMessage {
  heading: string;
  detail: string;
}

/**
 * A failed search in the reader's terms. `ApiError.status` is what separates them, which is
 * why 4.2 gave every transport failure one — including the ones that never reached a server.
 */
export function describeApiError(error: ApiError): ErrorMessage {
  //Nothing ever left the browser: a dropped connection, DNS, CORS, or — the likely one
  //under free-tier hosting — an instance that has gone to sleep and is starting up.
  if (error.status === NETWORK_ERROR_STATUS) {
    return {
      heading: "Could not reach the search API.",
      detail:
        "Check your connection. If the server is on a free tier it may be starting up — try again in a moment.",
    };
  }

  //The limiter counts per minute, so the only useful advice is to wait. 4.3 deliberately
  //does not retry this: every retry lands inside the same window and spends part of the
  //next one getting there.
  if (error.status === 429) {
    return {
      heading: "Too many searches, too quickly.",
      detail: "The API allows 60 searches a minute. Wait a moment and try again.",
    };
  }

  if (error.status >= 500) {
    return {
      heading: "The search API had a problem.",
      detail: "This one is the server's fault, not the query's. Try again shortly.",
    };
  }

  //Everything else is a 4xx: a query the server would not accept, or a path that is not
  //mounted. Both are worth quoting verbatim, because the server said which.
  return { heading: "That search could not be run.", detail: error.message };
}

/**
 * The query is crawled-corpus-adjacent user input echoed back into the page, so it goes
 * through JSX as a text node like everything else. The quotes are typographic rather than
 * `"` so a query containing a quote does not read as if it ended early.
 */
function quote(query: string): string {
  return `“${query}”`;
}
