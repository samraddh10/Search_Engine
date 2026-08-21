import type { ReactNode } from "react";
import type { SearchResponse } from "shared";
import { emptyResultsHeading } from "../lib/searchMessages.ts";

/**
 * Why a result list is empty, and what to do about it.
 *
 * The heading comes from `searchMessages` rather than from the branches below, because
 * `SearchPage`'s live region announces the same sentence — see that module for why the
 * words live outside the component that shows them.
 */
export interface EmptyResultsProps {
  response: SearchResponse;
  onGoToFirstPage: () => void;
}

export function EmptyResults({ response, onGoToFirstPage }: EmptyResultsProps) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium text-heading">{emptyResultsHeading(response)}</p>
      <p className="text-sm text-text">{explanation(response, onGoToFirstPage)}</p>
    </div>
  );
}

function explanation(response: SearchResponse, onGoToFirstPage: () => void): ReactNode {
  if (response.status === "empty-index") {
    return (
      <>
        The corpus is empty, so there is nothing to search. Run <Code>npm run crawl</Code>{" "}
        to fetch some pages, then <Code>npm run index</Code> to build the inverted index.
      </>
    );
  }

  if (response.status === "no-searchable-terms") {
    return (
      <>
        Words like <em>the</em>, <em>and</em> and <em>of</em> appear in nearly every
        document, so the index does not carry them — there was nothing left to look up. Try
        a more specific word.
      </>
    );
  }

  if (response.total === 0) {
    return (
      <>
        Every term is matched as a stem, so spelling matters more than word endings. Check
        the spelling, or try a broader word.
      </>
    );
  }

  return (
    <>
      There are {response.total} results for “{response.query}”, but this page is beyond the
      last one.{" "}
      <button type="button" onClick={onGoToFirstPage} className="rounded text-accent hover:underline">
        Back to the first page
      </button>
      .
    </>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-xs text-heading">
      {children}
    </code>
  );
}
