import { QueryClient } from "@tanstack/react-query";
import { ApiError, NETWORK_ERROR_STATUS } from "./api.ts";

const MAX_RETRIES = 2;

const STALE_TIME_MS = 5 * 60_000;

/** Kept in memory past the last observer, so paging back and forth is free. */
const GC_TIME_MS = 10 * 60_000;


export function shouldRetry(failureCount: number, error: Error): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (!(error instanceof ApiError)) return false;

  return error.status === NETWORK_ERROR_STATUS || error.status >= 500;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_TIME_MS,
      gcTime: GC_TIME_MS,
      retry: shouldRetry,
      //Search results do not change because a window regained focus, and `/statistics`
      //shares the 60-per-minute limiter with `/search` — so the default would spend the
      //search budget on tab switches.
      refetchOnWindowFocus: false,
    },
  },
});
