//The inverted index itself — the piece the rest of the engine is arranged around. Everything
//before this maps a document to its words; this flips the corpus over so a *word* names the
//documents containing it, which is the only direction a search engine can be queried in.
//
//Deliberately pure: no SQL, no connections, no clock. Documents arrive as an iterable the
//caller supplies (2.3's batch job hands it a `pg` cursor; a test hands it an array), and the
//result is one value 2.3 writes. Same rule `crawl()` follows for the frontier and
//`DocumentStore` for its `Queryable` — exactly one entry point owns connections.
import { indexableText, processText } from "../processing/pipeline.js";
import { buildDocumentPostings } from "./postings.js";

/** The `documents` columns the index is built from. */
export interface IndexableDocument {
  id: number;
  title: string;
  contentText: string;
}

/** One document's entry in a term's posting list — one `postings` row. */
export interface PostingEntry {
  docId: number;
  tf: number;
  positions: number[];
}

/** One `terms` row, with its posting list attached. */
export interface IndexedTerm {
  /** The stem, as stored in `terms.term`. */
  term: string;
  //`terms.surface_form`: the spelling shown to a user, since "comput" is not something 3.3
  //can put in an autocomplete dropdown.
  surfaceForm: string;
  //`terms.doc_freq` is this array's length, and is deliberately not stored a second time. The
  //tf/positions redundancy in the schema buys a cheaper hot path at query time; there is no
  //equivalent argument in memory for a count of an array we are already holding, only the
  //chance of the two disagreeing.
  postings: PostingEntry[];
}

/** The single `corpus_stats` row — BM25's `N` and `avgdl`. */
export interface CorpusStats {
  totalDocs: number;
  //Sum of every document's indexed length. Note `corpus_stats.total_tokens` is BIGINT, which
  //node-postgres returns as a *string*; that conversion is 2.3's problem, not this module's.
  totalTokens: number;
  avgDocLen: number;
}

export interface BuiltIndex {
  //Keyed by stem. Iteration order is first appearance across the corpus — deterministic for a
  //given document order, which is what makes the tests and a re-run of the job comparable.
  terms: Map<string, IndexedTerm>;
  /** `documents.token_count` per document id. */
  docLengths: Map<number, number>;
  stats: CorpusStats;
}

interface TermAccumulator {
  postings: PostingEntry[];
  surfaces: Map<string, number>;
}

/**
 * Choose the display spelling for a stem: the most frequent surface form, breaking ties by
 * shortest and then lexicographically.
 *
 * The tie-break is not decoration. Without it the winner between two equally common spellings
 * would depend on which document happened to be read first, so the same corpus indexed twice
 * could put different words in front of a user. Shortest-first because the shorter spelling is
 * usually the base form ("computer" over "computers"), which is what someone typing a prefix
 * expects to see.
 */
//What it does: given a tally of "which spellings produced this stem, and how often," picks the one spelling that should be shown to a user (e.g., stored in terms.surface_form).
export function pickSurfaceForm(surfaces: ReadonlyMap<string, number>): string {
  let best = "";
  let bestCount = -1;

  for (const [surface, count] of surfaces) {
    if (
      count > bestCount ||
      (count === bestCount &&
        (surface.length < best.length ||
          (surface.length === best.length && surface < best)))
    ) {
      best = surface;
      bestCount = count;
    }
  }

  return best;
}

//It accepts AsyncIterable | Iterable — meaning it can be handed either a real Postgres cursor (async, pulls rows from the DB as you go) or a plain in-memory array (sync, for tests) 
// — for await in TypeScript works transparently over both.
//What it does: the whole file's job in one function — reads every document once, and returns the complete BuiltIndex (terms map, doc lengths, corpus stats).
//It holds the entire corpus in memory at once, rather than streaming results out in batches — because doc_freq (how many docs contain a term) 
// literally cannot be known correctly until every document has been read.
export async function buildIndex(
  docs: AsyncIterable<IndexableDocument> | Iterable<IndexableDocument>,
): Promise<BuiltIndex> {
  //accumulators builds up each term's postings-in-progress (keyed by stem)
  const accumulators = new Map<string, TermAccumulator>();
  //docLengths records each document's indexed length
  const docLengths = new Map<number, number>();
  //totalTokens sums all of it for the average later.
  let totalTokens = 0;

  //For every incoming document: first, a guard. If this doc.id was already processed, throw.
  for await (const doc of docs) {
    if (docLengths.has(doc.id)) {
      throw new Error(`buildIndex received document id ${doc.id} twice`);
    }

    //indexableText(doc) — its job is to join doc.title and doc.contentText into one string the same way, every time.
    const tokens = processText(indexableText(doc));

    //Survivors, not the raw stream — so the length BM25 penalizes a document for is the length
    //its postings actually represent. A document with no indexable tokens still counts toward
    //totalDocs: it is in the corpus, and BM25's N is a count of documents, not of non-empty ones.
    docLengths.set(doc.id, tokens.length);
    totalTokens += tokens.length;

    for (const [term, posting] of buildDocumentPostings(tokens)) {
      let accumulator = accumulators.get(term);

      if (accumulator === undefined) {
        accumulator = { postings: [], surfaces: new Map() };
        accumulators.set(term, accumulator);
      }

      //One posting per (term, document), and a document is only ever visited once — the
      //duplicate-id guard above is what makes that true, and what keeps this a push rather
      //than a merge.
      accumulator.postings.push({ docId: doc.id, tf: posting.tf, positions: posting.positions });

      for (const [surface, count] of posting.surfaces) {
        accumulator.surfaces.set(surface, (accumulator.surfaces.get(surface) ?? 0) + count);
      }
    }
  }

  //Once every document has been scanned, convert the working accumulators map into the final terms map
  const terms = new Map<string, IndexedTerm>();
  for (const [term, accumulator] of accumulators) {
    terms.set(term, {
      term,
      surfaceForm: pickSurfaceForm(accumulator.surfaces),
      postings: accumulator.postings,
    });
  }

  //totalDocs is just how many entries ended up in docLengths
  const totalDocs = docLengths.size;

  return {
    terms,
    docLengths,
    stats: {
      totalDocs,
      totalTokens,
      //Guarded rather than left to produce NaN on an empty corpus: NaN propagates silently
      //through every BM25 score and yields an unranked result list with nothing raised to say
      //why. Zero is at least visibly wrong.
      avgDocLen: totalDocs === 0 ? 0 : totalTokens / totalDocs,
    },
  };
}
