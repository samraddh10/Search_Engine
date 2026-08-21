import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Suggestion } from "shared";
import { useDebounce } from "use-debounce";
import { fetchSuggestions, type ApiError } from "../services/api.ts";

const SUGGESTION_DEBOUNCE_MS = 200;

export interface UseSuggestionsResult {
  /** Never `undefined` — a combobox with nothing to show has an empty list, not a missing one. */
  suggestions: Suggestion[];
  isLoading: boolean;
  error: ApiError | null;
}

export function useSuggestions(input: string): UseSuggestionsResult {
  const [debounced] = useDebounce(input, SUGGESTION_DEBOUNCE_MS);

  //A cleared box clears the list immediately rather than 200ms later. Every other
  //transition can afford to lag one debounce behind, but this one is the user asking the
  //suggestions to go away, and leaving them hanging under an empty input reads as broken.
  const term = input === "" ? "" : debounced;

  
  const enabled = term.trim().length > 0;

  const { data, isLoading, error } = useQuery<Suggestion[], ApiError>({
    queryKey: ["suggestions", term],
    queryFn: ({ signal }) => fetchSuggestions(term, { signal }),
    enabled,
    placeholderData: enabled ? keepPreviousData : undefined,
  });

  return { suggestions: data ?? [], isLoading, error };
}
