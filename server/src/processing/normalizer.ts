//Why \u0300-\u036f instead of \p{M} (stripping all marks would merge distinct Devanagari/Arabic/Hebrew words)
const LATIN_COMBINING_MARKS = /[\u0300-\u036f]/g;

const DISALLOWED = /[^\p{L}\p{N}\p{M}]/gu;

export function normalizeToken(raw: string): string {
  return raw
  //NFKC / NFKD — same idea, but also fold in compatibility equivalences: characters that look/behave differently but represent "the same underlying text for search purposes.
  // " A ligature like ﬁ is a compatibility variant of f + i.
    .normalize("NFKC")
    .toLowerCase()
    //NFD — Canonical Decomposition: prefer base + combining mark pairs (e + ´ as two codepoints).
    .normalize("NFD")
    .replace(LATIN_COMBINING_MARKS, "")
    //NFC — Canonical Composition: prefer single precomposed characters where they exist (é as one codepoint).
    .normalize("NFC")
    .replace(DISALLOWED, "");
}
