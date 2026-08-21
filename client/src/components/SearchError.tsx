import { NETWORK_ERROR_STATUS, type ApiError } from "../services/api.ts";

export interface SearchErrorProps {
  error: ApiError;
}

export function SearchError({ error }: SearchErrorProps) {
  const { heading, detail } = describe(error);

  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-lg border border-border p-4"
    >
      <p className="font-medium text-heading">{heading}</p>
      <p className="text-sm text-text">{detail}</p>
    </div>
  );
}

function describe(error: ApiError): { heading: string; detail: string } {
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
