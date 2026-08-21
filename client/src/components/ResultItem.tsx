import type { SearchResult } from "shared";
import { splitSnippet } from "../lib/splitSnippet.ts";

/**
 * One result: title, URL, the snippet with its matched terms marked, and the BM25 score.
 *
 * **The snippet is rendered as text nodes split at the server's offsets** — 3.2 decision
 * 8's obligation, and the reason no HTML crosses the wire. `splitSnippet` does the
 * arithmetic; this file only decides that a highlighted segment is a `<mark>`.
 */
export interface ResultItemProps {
  result: SearchResult;
}

export function ResultItem({ result }: ResultItemProps) {
  const segments = splitSnippet(result.snippet, result.matches);

  return (
    <li className="flex flex-col gap-1">
      <a
        href={result.url}
        className="text-lg text-heading underline-offset-4 hover:text-accent hover:underline"
      >
        {/* A crawled page can have no `<title>`; the URL is the only name it has. */}
        {result.title || readableUrl(result.url)}
      </a>

      <p className="truncate text-sm text-text">{readableUrl(result.url)}</p>

      <p className="text-text">
        {segments.map((segment, index) =>
          segment.highlighted ? (
            //`index` is a sound key here: the array is derived from this render's props and
            //is positionally stable, and nothing in it holds state.
            <mark key={index} className="bg-accent-bg font-medium text-heading">
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>

      <p className="text-xs text-text">BM25 {result.score.toFixed(4)}</p>
    </li>
  );
}


function readableUrl(url: string): string {
  try {
    const { host, pathname, search } = new URL(url);
    const path = decodeURI(`${pathname}${search}`);

    return path === "/" ? host : `${host}${path}`;
  } catch {
    return url;
  }
}
