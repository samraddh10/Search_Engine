import type { ReactNode } from "react";
import type { SearchResponse } from "shared";

export interface EmptyResultsProps {
  response: SearchResponse;
  onGoToFirstPage: () => void;
}

export function EmptyResults({ response, onGoToFirstPage }: EmptyResultsProps) {
  if (response.status === "empty-index") {
    return (
      <Message heading="Nothing is indexed yet.">
        The corpus is empty, so there is nothing to search. Run <Code>npm run crawl</Code>{" "}
        to fetch some pages, then <Code>npm run index</Code> to build the inverted index.
      </Message>
    );
  }

  if (response.status === "no-searchable-terms") {
    return (
      <Message heading="That query is all stopwords.">
        Words like <em>the</em>, <em>and</em> and <em>of</em> appear in nearly every
        document, so the index does not carry them — there was nothing left to look up. Try
        a more specific word.
      </Message>
    );
  }

  if (response.total === 0) {
    return (
      <Message heading={`No documents match ${quote(response.query)}.`}>
        Every term is matched as a stem, so spelling matters more than word endings. Check
        the spelling, or try a broader word.
      </Message>
    );
  }

  return (
    <Message heading={`Page ${response.page} is past the end.`}>
      There are {response.total} results for {quote(response.query)}, but this page is
      beyond the last one.{" "}
      <button type="button" onClick={onGoToFirstPage} className="text-accent hover:underline">
        Back to the first page
      </button>
      .
    </Message>
  );
}

function Message({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium text-heading">{heading}</p>
      <p className="text-sm text-text">{children}</p>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-xs text-heading">
      {children}
    </code>
  );
}

/**
 * The query is crawl-adjacent user input echoed back into the page, so it goes through JSX
 * as a text node like everything else. The quotes are typographic rather than `"` so a
 * query containing a quote does not read as if it ended early.
 */
function quote(query: string): string {
  return `“${query}”`;
}
