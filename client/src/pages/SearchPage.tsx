import { useEffect, useRef } from "react";
import { EmptyResults } from "../components/EmptyResults.tsx";
import { ExampleQueries } from "../components/ExampleQueries.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { ResultList } from "../components/ResultList.tsx";
import { ResultsSkeleton } from "../components/ResultsSkeleton.tsx";
import { SearchBox } from "../components/SearchBox.tsx";
import { SearchError } from "../components/SearchError.tsx";
import { StatsBar } from "../components/StatsBar.tsx";
import { SITE_NAME, useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { useSearch } from "../hooks/useSearch.ts";
import { useSearchUrl } from "../hooks/useSearchUrl.ts";
import { describeApiError, emptyResultsHeading } from "../lib/searchMessages.ts";


export function SearchPage() {
  const { query, page, submitQuery, goToPage } = useSearchUrl();
  const { data, isLoading, error, isPlaceholderData } = useSearch({ query, page });

  useDocumentTitle(query ? `${query} — ${SITE_NAME}` : SITE_NAME);

  //`pageSize` comes from the response rather than from the shared default, so the arithmetic
  //follows whatever the server actually applied.
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const hasResults = Boolean(data && data.results.length > 0);

  const statusRef = useRef<HTMLParagraphElement>(null);
  const shouldFocusStatus = useRef(false);

  /**
   * Paging moves focus to the status line, and the reason is a bug rather than a nicety:
   * clicking `Next` onto the last page *disables the button under the cursor*, and a
   * disabled element cannot hold focus — so a keyboard user is dropped back to the top of
   * the document, on the page they just asked to leave. Sending focus to the status line
   * instead answers the click ("page 2 of 4"), puts the AT cursor at the head of the new
   * results, and scrolls them into view for everyone else.
   *
   * The flag is only raised when the page will actually change, which is what keeps it from
   * being consumed by an unrelated later render — `Pagination` deliberately leaves the
   * current page's button enabled, so it can be clicked as a no-op.
   */
  function handlePageChange(next: number) {
    if (next === page) return;

    shouldFocusStatus.current = true;
    goToPage(next);
  }

  useEffect(() => {
    if (!shouldFocusStatus.current) return;

    shouldFocusStatus.current = false;
    statusRef.current?.focus();
  }, [page]);

  /**
   * What the live region says, in the order the render branches below resolve.
   *
   * Both empty-state sentences are the *same strings the components below render*, taken
   * from the functions those components use to build their own headings — a second wording
   * here would announce something the page does not say.
   */
  function statusMessage(): string {
    if (!query) return "";
    if (error) return describeApiError(error).heading;
    if (isLoading) return "Searching…";
    if (!data) return "";
    if (data.results.length === 0) return emptyResultsHeading(data);

    //A comma, not the `·` used for the visual separators elsewhere: this string is read
    //aloud now, and a middle dot is either silence or "middle dot" depending on the reader.
    return `${data.total.toLocaleString()} result${data.total === 1 ? "" : "s"}, page ${data.page} of ${totalPages}`;
  }

  return (
    <div className="flex flex-col gap-8">
      {/*
        The heading is the same element in both states so `SearchBox` keeps a fixed place in
        the tree. Branching the whole page on `query` would remount the input on the first
        search and drop focus out of it mid-interaction.
      */}
      <h1 className={query ? "sr-only" : ""}>
        {query ? (
          `Search results for ${query}`
        ) : (
          /*
            Two files rather than one, because the wordmark is a solid colour baked into
            pixels: the white lockup vanishes on the light theme and a dark one vanishes on
            the dark theme. `<picture>` swaps them on `prefers-color-scheme`, which is the
            same signal `index.css` themes everything else with — there is no manual toggle
            to keep in sync. The blue mark is identical in both; only the wordmark changes.

            `alt` is the heading's text, so the accessible name of this page is "wisp".
            Intrinsic width/height are declared so the row does not reflow once the image
            loads, and the height is then set in CSS.
          */
          <picture>
            <source srcSet="/wisp-dark.png" media="(prefers-color-scheme: dark)" />
            <img
              src="/wisp-light.png"
              alt="wisp"
              width={296}
              height={89}
              className="h-12 w-auto"
            />
          </picture>
        )}
      </h1>

      <SearchBox query={query} onSubmit={submitQuery} />

      <section aria-busy={isLoading} className="flex flex-col gap-6">
        {!query && (
          <div className="flex flex-col gap-2">
            <p>
              Search a corpus this project crawled, tokenized and indexed itself. Ranking is
              BM25 over a custom inverted index — no Elasticsearch.
            </p>
            <StatsBar />
            <ExampleQueries onSelect={submitQuery} />
          </div>
        )}

        {/*
          The one live region in the app, and it holds a *sentence* rather than the results.

          4.4 announced the whole section, which meant every title, URL, snippet and score
          was queued for reading on every search — and, because `role="alert"` is itself a
          live region, an error was announced twice. A search engine's result list is
          something you navigate, not something that should be read at you; what belongs in
          a live region is the one line saying what happened.

          Always mounted, never conditionally rendered: a live region has to be in the
          document *before* its text changes, or the change is the region appearing and
          screen readers may say nothing at all. So it stays and its text swaps, visible on
          the branch where the count is the useful thing to look at and `sr-only` on the
          branches where the words are already on screen underneath it.

          `tabIndex={-1}` makes it a focus target for paging without putting it in the tab
          order.
        */}
        <p
          ref={statusRef}
          tabIndex={-1}
          role="status"
          className={hasResults ? "text-sm text-text" : "sr-only"}
        >
          {statusMessage()}
        </p>

        {query && error && <SearchError error={error} />}

        {/*
          `isLoading`, not `isPending`: a disabled query stays pending forever, so a skeleton
          keyed on the latter would render on the empty state and never stop. It is also why
          this branch is rare — `keepPreviousData` means paging is not loading.
        */}
        {query && !error && isLoading && <ResultsSkeleton />}

        {query && !error && !isLoading && data && (
          <>
            {data.results.length === 0 ? (
              <EmptyResults response={data} onGoToFirstPage={() => handlePageChange(1)} />
            ) : (
              <>
                <ResultList results={data.results} isStale={isPlaceholderData} />

                <Pagination
                  page={data.page}
                  totalPages={totalPages}
                  onPageChange={handlePageChange}
                />
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
