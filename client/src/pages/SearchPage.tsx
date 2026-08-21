import { EmptyResults } from "../components/EmptyResults.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { ResultList } from "../components/ResultList.tsx";
import { ResultsSkeleton } from "../components/ResultsSkeleton.tsx";
import { SearchBox } from "../components/SearchBox.tsx";
import { SearchError } from "../components/SearchError.tsx";
import { StatsBar } from "../components/StatsBar.tsx";
import { useSearch } from "../hooks/useSearch.ts";
import { useSearchUrl } from "../hooks/useSearchUrl.ts";


export function SearchPage() {
  const { query, page, submitQuery, goToPage } = useSearchUrl();
  const { data, isLoading, error, isPlaceholderData } = useSearch({ query, page });

  //`pageSize` comes from the response rather than from the shared default, so the arithmetic
  //follows whatever the server actually applied.
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="flex flex-col gap-8">
      {/*
        The heading is the same element in both states so `SearchBox` keeps a fixed place in
        the tree. Branching the whole page on `query` would remount the input on the first
        search and drop focus out of it mid-interaction.
      */}
      <h1
        className={
          query ? "sr-only" : "text-4xl font-medium tracking-tight text-heading"
        }
      >
        {query ? `Search results for ${query}` : "Search"}
      </h1>

      <SearchBox query={query} onSubmit={submitQuery} />

      {/*
        One live region over every outcome, so a screen reader hears the result count, the
        error, or the reason the list is empty without the page having to manage focus.
      */}
      <section aria-live="polite" aria-busy={isLoading} className="flex flex-col gap-6">
        {!query && (
          <div className="flex flex-col gap-2">
            <p>
              Search a corpus this project crawled, tokenized and indexed itself. Ranking is
              BM25 over a custom inverted index — no Elasticsearch.
            </p>
            <StatsBar />
          </div>
        )}

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
              <EmptyResults response={data} onGoToFirstPage={() => goToPage(1)} />
            ) : (
              <>
                <p className="text-sm text-text">
                  {data.total.toLocaleString()} result{data.total === 1 ? "" : "s"} · page{" "}
                  {data.page} of {totalPages}
                </p>

                <ResultList results={data.results} isStale={isPlaceholderData} />

                <Pagination page={data.page} totalPages={totalPages} onPageChange={goToPage} />
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
