import { MAX_QUERY_LENGTH } from "shared";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router";

//Phase 4.1 shell. The query lives in the URL rather than in component state, which is the
//whole reason routing stopped being optional: a result page has to be shareable and the
//back button has to step through searches. 4.3's hooks read this same parameter and 4.4
//replaces the bare input below with the real SearchBox and its suggestion combobox.
export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q")?.trim() ?? "";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = String(new FormData(event.currentTarget).get("q") ?? "").trim();
    //Dropping the parameter entirely on an empty query keeps the URL honest: `/` is the
    //empty state, `/?q=` is a search for nothing.
    setSearchParams(submitted ? { q: submitted } : {});
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-4xl font-medium tracking-tight text-heading">Search</h1>

      <form onSubmit={handleSubmit} role="search">
        <input
          type="search"
          name="q"
          //Remounts the uncontrolled input whenever the URL query changes, so a back
          //navigation moves the text in the box and not just the results below it.
          key={query}
          defaultValue={query}
          //The server rejects anything longer; stopping it here turns a 400 into a
          //non-event.
          maxLength={MAX_QUERY_LENGTH}
          placeholder="Search the indexed corpus"
          aria-label="Search query"
          className="w-full rounded-lg border border-border bg-transparent px-4 py-3 text-heading outline-none transition-colors placeholder:text-text focus-visible:border-accent-border"
        />
      </form>

      {query ? (
        <p>
          Showing results for <span className="text-heading">{query}</span>. Result
          rendering arrives in Phase 4.4.
        </p>
      ) : (
        <p>Enter a query to search the indexed corpus.</p>
      )}
    </div>
  );
}
