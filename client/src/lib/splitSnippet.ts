import type { SearchMatch } from "shared";

/**
 * Turns a snippet plus the server's match offsets into a flat run of segments, so a
 * component can render each one as a text node.
 *
 * This function is the whole of Phase 3.2 decision 8. The server deliberately sends plain
 * text and `{start, end}` offsets rather than markup — no HTML crosses the wire — and the
 * obligation it handed to Phase 4 in exchange is that the client splits the string and
 * renders text nodes, **never `dangerouslySetInnerHTML`**. A snippet is a substring of
 * `content_text`, which is text extracted from a page we crawled: it is attacker-supplied,
 * and this is the last point where an injection could turn into markup. 5.6's XSS test
 * targets this module, which is why it is a standalone pure function rather than JSX
 * inlined into `ResultItem` — it can be driven with plain Vitest and string literals, with
 * no jsdom and no Testing Library.
 *
 * Offsets are snippet-relative and were computed against the *assembled* string, ellipses
 * included (3.2 decision 4), so they index directly into what is passed here. They are also
 * UTF-16 code-unit offsets on both sides, because the server derived them from a JS string
 * through the same `processText` pass.
 *
 * @returns segments whose `text` concatenates back to `snippet` exactly. That invariant is
 * the point of the normalization below: no arrangement of offsets — overlapping, reversed,
 * out of range, fractional — can drop or duplicate a character of the document. A wrong
 * highlight is a cosmetic bug; silently eating text out of the snippet would be a
 * correctness one, and it would look like a rendering glitch rather than bad data.
 */
export interface SnippetSegment {
  text: string;
  /** Rendered inside a `<mark>` rather than as bare text. */
  highlighted: boolean;
}

export function splitSnippet(
  snippet: string,
  matches: readonly SearchMatch[],
): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let cursor = 0;

  for (const [start, end] of normalizeMatches(snippet.length, matches)) {
    if (start > cursor) {
      segments.push({ text: snippet.slice(cursor, start), highlighted: false });
    }
    segments.push({ text: snippet.slice(start, end), highlighted: true });
    cursor = end;
  }

  if (cursor < snippet.length) {
    segments.push({ text: snippet.slice(cursor), highlighted: false });
  }

  return segments;
}

/**
 * Clamped, sorted, and merged — in that order, because each step depends on the last.
 *
 * The server's offsets are trustworthy today; this is not a guard against 3.2, it is a
 * guard against the pairing being wrong. A client cached by a browser can outlive the
 * server it was built against, and an index rebuilt under a changed snippet budget is
 * exactly the kind of skew that produces offsets pointing past the end of a shorter
 * string. `slice` answers that silently with `""` or with the whole tail, so the check has
 * to happen here rather than being left to it.
 *
 * Merging is not only defensive: two matches that touch (`[0,3]` and `[3,7]`) render
 * identically as one `<mark>` and as two adjacent ones, and one node is the better tree.
 */
function normalizeMatches(
  length: number,
  matches: readonly SearchMatch[],
): Array<[start: number, end: number]> {
  const spans = matches
    .map(({ start, end }): [number, number] => [clamp(start, length), clamp(end, length)])
    //Drops empty and reversed spans. An empty one would emit a zero-length `<mark>` — an
    //invisible node that reads as a bug in the DOM inspector — and a reversed one would
    //rewind the cursor and re-emit text already written.
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];

  for (const span of spans) {
    const previous = merged.at(-1);

    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push(span);
  }

  return merged;
}

/** `NaN` and `Infinity` land on 0, where the `start < end` filter then discards the span. */
function clamp(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;

  return Math.min(Math.max(Math.trunc(value), 0), length);
}
