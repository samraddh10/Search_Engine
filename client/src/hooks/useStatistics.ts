import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Statistics } from "shared";
import { fetchStatistics, type ApiError } from "../services/api.ts";

/**
 Why there are no per-query options here. The /statistics endpoint shares its rate limit (a cap on how many requests are allowed per minute — here, 60 per minute) 
 with the /search endpoint. If this hook refetched aggressively on its own, every one of those refetches would eat into the same budget that real user searches need. 
 Rather than this hook adding its own caching rules to prevent that,
 */
export function useStatistics(): UseQueryResult<Statistics, ApiError> {
  return useQuery<Statistics, ApiError>({
    queryKey: ["statistics"],
    queryFn: ({ signal }) => fetchStatistics({ signal }),
  });
}
