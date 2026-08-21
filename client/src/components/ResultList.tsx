import type { SearchResult } from "shared";
import { ResultItem } from "./ResultItem.tsx";

/**
 * The ranked list.
 *
 * An `<ol>` rather than a `<ul>`, because the order is the answer — it is what BM25 was for,
 * and a screen reader announcing "list item 1 of 10" is reporting the rank.
 *
 * `isStale` dims the list while the next page loads. It comes from TanStack's
 * `isPlaceholderData`: 4.3 kept the current page rendered during a page change specifically
 * so paging would not blank the list and lose the scroll position, and the dimming is what
 * keeps that from looking like nothing happened.
 */
export interface ResultListProps {
  results: SearchResult[];
  isStale?: boolean;
}

export function ResultList({ results, isStale = false }: ResultListProps) {
  return (
    <ol
      className={`flex flex-col gap-8 transition-opacity ${isStale ? "opacity-50" : ""}`}
      aria-busy={isStale}
    >
      {results.map((result) => (
        <ResultItem key={result.docId} result={result} />
      ))}
    </ol>
  );
}
