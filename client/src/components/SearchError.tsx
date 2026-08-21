import { describeApiError } from "../lib/searchMessages.ts";
import type { ApiError } from "../services/api.ts";

/**
 * A failed search, in words.
 *
 * **No `role="alert"`.** An alert is itself a live region, and `SearchPage` already has the
 * one this app gets — an error inside both was announced twice. The status line speaks the
 * heading below; this component is what you look at.
 */
export interface SearchErrorProps {
  error: ApiError;
}

export function SearchError({ error }: SearchErrorProps) {
  const { heading, detail } = describeApiError(error);

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
      <p className="font-medium text-heading">{heading}</p>
      <p className="text-sm text-text">{detail}</p>
    </div>
  );
}
