import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 It explains why this centralization matters, and it's worth restating in plain terms before touching the code: if two different components (a SearchBox that sets the query text, 
 and a Pagination control that sets the page number) were each allowed to write to the URL independently — by copying the current params and changing just their one field — you'd get a real bug. 
 Picture this sequence: someone searches "cat," pages forward to page 3, then types a new search, "dog." If SearchBox builds its update by copying the existing params (which still say page=3) 
 and only overwriting q, the new URL becomes ?q=dog&page=3 — a brand-new search that silently starts on page 3, even though page 3 of "dog" results may not even exist. This bug wouldn't show up on someone's first search ever, 
 only on their second search after they'd paginated once — the kind of bug that's easy to miss in testing. This file prevents it by construction: only this hook is allowed to write to the URL,
  and its submitQuery function always builds the new params from scratch, deliberately leaving page out.
 */
export interface SearchUrlState {
  /** Trimmed, and `""` when absent. Never whitespace-only, which the server would 400. */
  query: string;
  //the current page, 1-based (page 1 is the first page). Anything in the URL that can't sensibly be read as a page number defaults to 1.
  page: number;
  //call this to start a new search. It always resets to page 1, and it changes the browser history so the back button returns to whatever was on screen before.
  submitQuery: (next: string) => void;
  //call this to move to a different page of the same search. It doesn't touch the query text.
  goToPage: (next: number) => void;
}

//Purpose: read the current query and page out of the URL, and provide two functions that are the only sanctioned way to change them — one for starting a new search, one for changing pages —
export function useSearchUrl(): SearchUrlState {
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get("q")?.trim() ?? "";
  const page = parsePage(searchParams.get("page"));

  const submitQuery = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      setSearchParams(trimmed ? { q: trimmed } : {});
    },
    [setSearchParams],
  );

  const goToPage = useCallback(
    (next: number) => {
      setSearchParams(next > 1 ? { q: query, page: String(next) } : { q: query });
    },
    [query, setSearchParams],
  );

  return { query, page, submitQuery, goToPage };
}

function parsePage(raw: string | null): number {
  const parsed = Number(raw);

  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}
