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

export function isStopword(term: string): boolean {
  return STOPWORDS.has(term);
}
