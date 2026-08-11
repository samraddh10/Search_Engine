//The words too common to discriminate between documents. Dropping them shrinks the index
//and speeds up queries, at a cost worth stating plainly: a phrase made entirely of them
//("to be or not to be") becomes unsearchable, and no later phase can recover it, because
//the postings simply do not exist.
//
//Note that BM25 would already handle these gracefully on its own — a term appearing in
//nearly every document gets an IDF close to zero and contributes almost nothing to the
//score — so this is an index-size optimization, not a correctness requirement. It is the
//one lossy step in the pipeline that isn't lossy for a *reason*, which is why the list is
//kept short and conventional rather than tuned against the corpus.

//Stored in the form normalizeToken() produces, not in the form a human writes: lowercase,
//no apostrophes ("dont", not "don't"). A "don't" sitting in this list would never match
//anything the tokenizer emits and would be silently dead weight — stopwords.test.ts pins
//that by normalizing every entry and asserting it is unchanged.
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any",
  "are", "arent", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by",
  "cannot", "cant", "could", "couldnt",
  "did", "didnt", "do", "does", "doesnt", "doing", "dont", "down", "during",
  "each",
  "few", "for", "from", "further",
  "had", "hadnt", "has", "hasnt", "have", "havent", "having", "he", "hed", "hes", "her",
  "here", "heres", "hers", "herself", "him", "himself", "his", "how", "hows",
  "i", "id", "if", "ill", "im", "in", "into", "is", "isnt", "it", "its", "itself", "ive",
  "lets",
  "me", "more", "most", "mustnt", "my", "myself",
  "no", "nor", "not",
  "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves",
  "out", "over", "own",
  "same", "shant", "she", "shed", "shes", "should", "shouldnt", "so", "some", "such",
  "than", "that", "thats", "the", "their", "theirs", "them", "themselves", "then",
  "there", "theres", "these", "they", "theyd", "theyll", "theyre", "theyve", "this",
  "those", "through", "to", "too",
  "under", "until", "up",
  "very",
  "was", "wasnt", "we", "wed", "were", "werent", "weve", "what", "whats", "when", "whens",
  "where", "wheres", "which", "while", "who", "whom", "whos", "why", "whys", "with",
  "wont", "would", "wouldnt",
  "you", "youd", "youll", "youre", "your", "yours", "yourself", "yourselves", "youve",
]);

/**
 * Whether a *normalized, unstemmed* token should be dropped.
 *
 * The order matters and is fixed by this signature: the check must run before stemming, not
 * after. Porter turns "does" into "doe" and "having" into "have", so a list consulted after
 * the stemmer would let inflections of its own entries straight through — the words most
 * worth dropping would be exactly the ones that escaped.
 *
 * English only. `documents.lang` exists and a French page will keep its "le"/"de", which
 * simply means a slightly larger index for non-English pages rather than wrong results —
 * those terms are still ranked down by their own IDF. Add per-language lists here if the
 * corpus ever justifies it; the signature would take `lang` and fall back to English.
 */
export function isStopword(term: string): boolean {
  return STOPWORDS.has(term);
}
