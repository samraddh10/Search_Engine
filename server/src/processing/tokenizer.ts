//Splits raw text into candidate terms and, critically, remembers where each one came from.
//Runs on the *unnormalized* string so the offsets it reports stay valid against the caller's

/** One run of word characters, located in the string it was found in. */
export interface RawToken {
  //The slice exactly as it appeared, before any folding. `input.slice(start, end)` returns
  //this string; the pipeline's tests pin that.
  text: string;
  start: number;
  /** Exclusive, so `end - start === text.length`. */
  end: number;
}

//[\p{L}\p{N}]+ — a character class containing two Unicode property escapes: \p{L} means "any Letter, in any script" and 
// \p{N} means "any Number." The + means "one or more in a row." So this piece alone matches a plain run of letters/digits — "hello", "42", "café" (once composed).
//(?: ... )* — a non-capturing group (the ?: just means "group these for repetition purposes, but don't bother remembering what matched inside it separately"), repeated zero or more times with *.
//['’ʼ][\p{L}\p{N}]+ inside that group — an apostrophe character (there are three alternatives listed inside those brackets: the straight ', the curly ’, and ʼ which is U+02BC,
//  the "letter apostrophe" some languages use as an actual letter rather than punctuation), immediately followed by another run of one-or-more letters/digits.
const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}\p{N}]+)*/gu;

//Long enough for any real word — the longest in common English dictionaries is 45 characters
//— and short enough that a base64 blob, a minified script, or a long hash that survived 1.3's
//text extraction never becomes a term. Checked against the raw slice, so an oversized run is
//discarded before any normalization work is spent on it.
export const MAX_TOKEN_LENGTH = 64;

/**
 * Find every candidate term in `input`, in order of appearance.
 *
 * Positions are deliberately *not* assigned here — that is the pipeline's job, because it
 * needs to number tokens before stopwords are dropped, and this function does not know what
 * a stopword is.
 */
export function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];

  //Safe to share the module-level regex despite its /g flag: matchAll is specified to run
  //against a fresh clone rather than advancing the original's lastIndex, so consecutive
  //calls cannot resume mid-string the way a hand-rolled exec() loop can.
  for (const match of input.matchAll(TOKEN_PATTERN)) {
    const text = match[0];
    if (text.length > MAX_TOKEN_LENGTH) continue;

    tokens.push({ text, start: match.index, end: match.index + text.length });
  }

  return tokens;
}

