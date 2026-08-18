import type { SearchMatch } from "shared";
import { indexableText, processText, type IndexableFields } from "../processing/pipeline.js";
import { MAX_TOKEN_LENGTH } from "../processing/tokenizer.js";

export interface Snippet {
  snippet: string;
  matches: SearchMatch[];
}

export interface SnippetOptions {
  maxLength?: number;
}

export const SNIPPET_DEFAULTS = {
  maxLength: 300,
} as const;

//Purpose: a safety floor. MAX_TOKEN_LENGTH is the longest a single word/token is allowed to be (from the tokenizer). 
// This line says: no matter what the caller asks for, never shrink the window below the length of one token.
const MIN_SNIPPET_LENGTH = MAX_TOKEN_LENGTH;

//Ellipsis plus a space, so the marker never fuses with the first word. Its length is what every
//match offset is shifted by; nothing else in this module may change the string's head.
const ELLIPSIS_PREFIX = "… ";
const ELLIPSIS_SUFFIX = " …";

//How far past the window edge to look for a space before giving up and cutting mid-word. Long
//enough for any ordinary word, short enough that a URL or a hash — which 1.3's extraction can
//leave in the text — cannot drag the edge halfway across the snippet.
const BOUNDARY_SEARCH = 24;

/**
 * Build the snippet for one document, highlighting the query stems it matched.
 *
 * Takes the document's *fields* rather than a prepared string, so the caller cannot get the
 * join wrong: this calls `indexableText` itself, which is the contract 2.2 indexed against.
 * Reading `content_text` alone would shift every position by the title's token count and quote
 * the wrong sentence — the failure `indexableText` exists to make impossible.
 *
 * Positions come from re-running `processText`, not from `postings.positions`. The pipeline is
 * deterministic, so the re-run reproduces the stored ordinals *and* carries the character
 * offsets postings cannot hold; the stored copy is the same fact minus the half needed here.
 * It is also the version that stays self-consistent when the index is stale — a page re-crawled
 * but not reindexed has fresh text and old ordinals, and mixing the two quotes a confidently
 * wrong sentence.
 *
 * `matchedTerms` from 2.4 is the stem list to pass: it records a match even where the term's IDF
 * was zero, because the user can plainly see the word in the text.
 */
//Purpose: this is the one exported function that does the whole job for one document. Everything else in the file is a helper it calls in sequence.
export function buildSnippet(
  doc: IndexableFields,
  matchedStems: readonly string[],
  options: SnippetOptions = {},
): Snippet {
  const maxLength = Math.max(options.maxLength ?? SNIPPET_DEFAULTS.maxLength, MIN_SNIPPET_LENGTH);
//This is the key correctness move in the whole file. indexableText is the exact same function Phase 2 used when indexing — it joins the title and content into one string. 
// Positions computed against anything else (say, just contentText alone) would be shifted by however many characters the title added, and the snippet would quote the wrong sentence.
  const text = indexableText(doc);

  //Where the body starts inside the joined string. Derived by subtraction rather than from
  //`title.length + 2` so that changing `indexableText`'s separator cannot silently move it.
  const bodyStart = text.length - doc.contentText.length;

  if (bodyStart >= text.length) return { snippet: "", matches: [] };

  const wanted = new Set(matchedStems);

  //Body only. The title is already rendered directly above the snippet, so a window that landed
  //in it would print the same words twice in a two-line card. 2.2 anticipated the overlap and
  //accepted it; preventing it is cheaper than explaining it in the UI.
  const matched = processText(text).filter(
    (token) => token.start >= bodyStart && wanted.has(token.term),
  );

  //If nothing matched in the body — either because the only match was in the title, or the index is stale — fall back to just showing the start of the body
  if (matched.length === 0) return leadOfBody(text, bodyStart, maxLength);

  //Three remaining steps, each its own function: pick the best cluster of matches (selectWindow), turn that cluster into an actual character window (windowAround), 
  // then cut the text and compute final highlight positions (assemble).
  const [first, last] = selectWindow(matched, maxLength);
  const window = windowAround(text, bodyStart, matched[first]!.start, matched[last]!.end, maxLength);

  return assemble(text, bodyStart, window, matched);
}

//Purpose: given every place a query word occurs (matched, in order), decide which contiguous stretch is worth showing. 
// "Best" means: most distinct query words first, then most total matches, then earliest position. 
// The comment gives the reason for that ordering: for a two-word query, 
// a window with one of each word beats a window with four of one word and none of the other — a plain match-count would pick the wrong one.

//It's implemented as a two-pointer sliding window: a left edge that advances one match at a time, 
// and a right edge that only ever moves forward (never resets), which is what makes this O(n) instead of comparing every pair of matches.

//Returns indices into matched, not character positions — windowAround converts those afterward.
function selectWindow(
  matched: readonly { term: string; start: number; end: number }[],
  maxLength: number,
): [first: number, last: number] {
  //counts tracks how many times each term currently appears between left and right.
  const counts = new Map<string, number>();
  let distinct = 0;
  let right = 0;

  //best records the best window found so far — starting at distinct: -1 guarantees the very first real window will overwrite it.
  let best = { distinct: -1, count: -1, first: 0, last: 0 };

  for (let left = 0; left < matched.length; left++) {
    while (right < matched.length && matched[right]!.end - matched[left]!.start <= maxLength) {
      const term = matched[right]!.term;
      const seen = counts.get(term) ?? 0;
      if (seen === 0) distinct++;
      counts.set(term, seen + 1);
      right++;
    }

    //Compare the current window [left, right) against the best one seen so far. Note it's a strict >, not >= — so on a tie, the earlier window keeps its spot.
    const count = right - left;
    if (distinct > best.distinct || (distinct === best.distinct && count > best.count)) {
      best = { distinct, count, first: left, last: right - 1 };
    }

    //Before advancing left to the next match, remove matched[left] from the window's bookkeeping (since it's about to fall outside [left, right)), 
    // decrementing distinct if that was the term's last occurrence in the window.
    const term = matched[left]!.term;
    const seen = counts.get(term)!;
    if (seen === 1) {
      counts.delete(term);
      distinct--;
    } else {
      counts.set(term, seen - 1);
    }
  }

  return [best.first, best.last];
}

/**Purpose: Centre the character budget on the chosen cluster, then pull the edges out to whole words. */
function windowAround(
  text: string,
  bodyStart: number,
  clusterStart: number,
  clusterEnd: number,
  maxLength: number,
): [start: number, end: number] {
  //Never negative: a cluster wider than the budget simply gets no context, and the tail of it
  //is cut rather than the head — the first matches are the ones worth showing.
  const slack = Math.max(0, maxLength - (clusterEnd - clusterStart));

  let start = Math.max(bodyStart, clusterStart - Math.floor(slack / 2));
  let end = Math.min(text.length, start + maxLength);
  //Reclaim the budget when the window ran into the end of the document, so a match near the
  //last line still gets its leading context instead of a half-empty snippet.
  start = Math.max(bodyStart, end - maxLength);

  //Only bother snapping to word boundaries if the edge is actually cutting into the document (if start === bodyStart or end === text.length, 
  // that edge is already a natural boundary — the very start or end of the body — so there's nothing to snap).
  //The start snaps forward to the next space, but is clamped with Math.min(…, clusterStart) so it can never accidentally skip past the cluster it's supposed to be showing.
  if (start > bodyStart) start = Math.min(snapForward(text, start), clusterStart);
  //The end snaps backward to the previous space, clamped with Math.max(…, Math.min(clusterEnd, end)) so it never eats into the cluster either.
  if (end < text.length) end = Math.max(snapBackward(text, end), Math.min(clusterEnd, end));

  return [start, end];
}

//If the character right before from is already a space/newline/start-of-string, we're already at a boundary — nothing to cut, return as-is. Otherwise, 
// walk forward up to BOUNDARY_SEARCH (24) characters looking for a space, and return the position just after it.
function snapForward(text: string, from: number): number {
  //Already at a boundary — the previous character ended a word, so nothing is being cut.
  if (isBoundary(text[from - 1])) return from;

  const limit = Math.min(text.length, from + BOUNDARY_SEARCH);
  for (let i = from; i < limit; i++) {
    if (isBoundary(text[i])) return i + 1;
  }

  //No boundary within reach: a URL or a hash. Cutting it is better than dragging the window.
  return from;
}

//Mirror image of snapForward
function snapBackward(text: string, from: number): number {
  if (isBoundary(text[from])) return from;

  const limit = Math.max(0, from - BOUNDARY_SEARCH);
  for (let i = from; i > limit; i--) {
    if (isBoundary(text[i - 1])) return i - 1;
  }

  return from;
}

//A boundary is: off the end of the string, a space, or a newline.
//  undefined counts as a boundary because text[from - 1] when from === 0 returns undefined — the very start of a string is naturally a boundary too.
function isBoundary(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n";
}

//Purpose: take the raw [start, end] window computed above, tidy up any stray whitespace at its edges, decide whether ellipses are needed, 
// slice the text out, and — the whole reason for the careful ordering here — recompute every match's position relative to the snippet string that's actually being returned, not the original document.
function assemble(
  text: string,
  bodyStart: number,
  [windowStart, windowEnd]: [number, number],
  matched: readonly { start: number; end: number }[],
): Snippet {
  const start = trimForward(text, windowStart, windowEnd);
  const end = trimBackward(text, start, windowEnd);

  //Decided from the window rather than from the trimmed bounds: trimming a trailing newline off
  //the last block would otherwise leave `end < text.length` true and mark a complete snippet as
  //truncated.
  const prefix = windowStart > bodyStart ? ELLIPSIS_PREFIX : "";
  const suffix = windowEnd < text.length ? ELLIPSIS_SUFFIX : "";

  const shift = prefix.length - start;

  const matches = matched
    .filter((token) => token.start >= start && token.end <= end)
    .map((token) => ({ start: token.start + shift, end: token.end + shift }));

  return { snippet: prefix + flatten(text.slice(start, end)) + suffix, matches };
}

/**
 * Block separators become spaces.
 *
 * 1.3 emits `\n` between block elements, which renders as a line break in a terminal and as
 * nothing in particular in HTML. Substituting a single space is safe *because the lengths are
 * equal* — every offset computed above survives untouched. Any collapsing transform here would
 * not, and would need a full index mapping to stay correct.
 */
function flatten(slice: string): string {
  return slice.replace(/\n/g, " ");
}

function trimForward(text: string, from: number, limit: number): number {
  let start = from;
  while (start < limit && isBlank(text[start])) start++;
  return start;
}

function trimBackward(text: string, floor: number, from: number): number {
  let end = from;
  while (end > floor && isBlank(text[end - 1])) end--;
  return end;
}

function isBlank(char: string | undefined): boolean {
  return char === " " || char === "\n";
}

//leadOfBody — the fallback when nothing matched
//Purpose: if buildSnippet found zero matches in the body, this returns a normal "start of the page" preview instead of an empty card.
function leadOfBody(text: string, bodyStart: number, maxLength: number): Snippet {
  const start = trimForward(text, bodyStart, text.length);
  const truncated = start + maxLength < text.length;

  let end = Math.min(text.length, start + maxLength);
  if (truncated) end = snapBackward(text, end);
  end = trimBackward(text, start, end);

  const suffix = truncated ? ELLIPSIS_SUFFIX : "";

  return { snippet: flatten(text.slice(start, end)) + suffix, matches: [] };
}
