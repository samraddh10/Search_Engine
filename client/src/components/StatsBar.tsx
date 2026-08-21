import { useStatistics } from "../hooks/useStatistics.ts";

/**
 * What is in the corpus, shown on the empty state.
 *
 * Placement is the decision. On a results page the useful count is "12 results, page 1 of
 * 2" and a second row of corpus totals next to it is noise; on the empty state there is no
 * other number on screen, and "12 documents indexed" is the one thing that tells a first
 * visitor what they are about to search — a search box over an unknown corpus is a prompt
 * with no context.
 *
 * **A failed or pending fetch renders nothing.** `/statistics` shares the 60-per-minute
 * limiter with `/search` (3.5), so the honest failure here is a 429 caused by searching —
 * and an error message about decoration, on the empty state, next to a search box that
 * works, would report a problem the user does not have. The results are the product; this
 * is a caption.
 */
export function StatsBar() {
  const { data } = useStatistics();

  if (!data) return null;

  if (data.totalDocs === 0) {
    return <p className="text-sm text-text">Nothing is indexed yet.</p>;
  }

  return (
    <p className="text-sm text-text">
      {formatCount(data.totalDocs)} document{data.totalDocs === 1 ? "" : "s"} ·{" "}
      {formatCount(data.totalTokens)} tokens · {data.avgDocLen.toFixed(1)} words per document
      {/*
        `updatedAt` is null on a corpus that has never been indexed, and the null is the
        whole reason 3.3 added the field: the server reads the column as epoch milliseconds
        and reports an unindexed corpus as 0, which would render here as 1 January 1970 — a
        wrong answer where a missing one is correct.
      */}
      {data.updatedAt !== null && ` · indexed ${formatTimestamp(data.updatedAt)}`}
    </p>
  );
}

/** Thousands separators in the reader's locale; a bare `43187` is hard to size at a glance. */
function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

/**
 * Falls back to the raw string on anything `Date` cannot read, rather than printing
 * "Invalid Date" — the value is a timestamp the server derived from a column, so a
 * malformed one means something upstream is wrong and the raw text is the more useful clue.
 */
function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);

  if (Number.isNaN(parsed.getTime())) return iso;

  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
