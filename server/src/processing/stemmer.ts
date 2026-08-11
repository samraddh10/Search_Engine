import { stemmer } from "stemmer";

const MAX_CACHE_ENTRIES = 50_000;

const cache = new Map<string, string>();

export function stem(word: string): string {
  const cached = cache.get(word);
  if (cached !== undefined) return cached;

  const stemmed = stemmer(word);
  if (cache.size < MAX_CACHE_ENTRIES) cache.set(word, stemmed);

  return stemmed;
}

export function clearStemCache(): void {
  cache.clear();
}
