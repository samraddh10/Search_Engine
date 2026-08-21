//keepPreviousData —It means "while the new request is in flight, keep showing the last successful result instead of clearing the screen."
//UseQueryResult — the TypeScript type (a type = a compile-time description of a value's shape) describing everything useQuery returns: data, error, status, isLoading
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { DEFAULT_PAGE_SIZE, type SearchResponse } from "shared";
import { search, type ApiError } from "../services/api.ts";

/**
 * `GET /search` as a hook.
 *
 * Deliberately **not** debounced, unlike `useSuggestions`. The query it runs comes from the
 * URL, and the URL only moves when someone submits the form or clicks a page — both
 * explicit acts already waited on. Debouncing here would add a delay after the one
 * interaction in the app that has no ambiguity about whether the user meant it.
 *
 * The `signal` is what settles the out-of-order race the debounced suggestion input
 * creates one hook over: TanStack cancels a superseded query, `api.ts` lets the
 * `AbortError` through unwrapped, and the slow early response cannot overwrite the fast
 * late one.
 */
export interface UseSearchParams {
  /** Trimmed here as well as by `useSearchUrl`, so `"cat"` and `"cat "` are one cache entry. */
  query: string;
  /** 1-based. */
  page?: number;
  /** Omitted from the request when undefined, so the server's default applies. */
  pageSize?: number;
}

//Purpose: given a query string and optional pagination info, decide whether there's actually something worth searching for, and if so, 
// run (and cache) the request through TanStack Query — returning live loading/error/data state that a component can render directly.
export function useSearch({
  query,
  page,
  pageSize,
}: UseSearchParams): UseQueryResult<SearchResponse, ApiError> {
  const q = query.trim();
  const enabled = q.length > 0;

  return useQuery<SearchResponse, ApiError>({
    queryKey: ["search", q, page ?? 1, pageSize ?? DEFAULT_PAGE_SIZE],
    queryFn: ({ signal }) => search({ q, page, pageSize }, { signal }),
    enabled,
    placeholderData: enabled ? keepPreviousData : undefined,
  });
}
