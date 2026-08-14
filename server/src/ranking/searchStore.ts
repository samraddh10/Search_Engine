//Phase 2.4 — the query side of the database, and the only module under `ranking/` that knows
//SQL exists. `bm25.ts` and `scorer.ts` stay pure.
//
//The plan originally left this to 3.1. Moved a phase earlier for two reasons: without it 2.4
//ships two modules exercisable only by hand-written fixture numbers, and no query could be run
//against the real corpus until Phase 3 — the same gap 2.3 closed by printing `corpus_stats`
//*read back* from Postgres rather than from memory. And **3.1 reuses this rather than writing
//its own version of the join**, because two hand-written joins over the same three tables is
//exactly the drift `processQuery` exists to prevent one layer up.
//
//It takes its client as an argument, like `DocumentStore` and `indexStore` — an import of
//`db/pg.js` anywhere but `cli.ts` would undo the point of it.
import { uniqueTerms, type ScorablePosting, type TermPostings } from "./scorer.js";

/** The one method this module needs, so a pool and a checked-out client are both acceptable. */
export interface Queryable {
  query<R extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

//Purpose: describes the raw shape of one row as it comes back from Postgres for the posting-fetch query below
interface PostingRow extends Record<string, unknown> {
  term: string;
  doc_freq: number;
  doc_id: number;
  tf: number;
  token_count: number;
}

//Purpose: same idea as PostingRow, but for the second query in this file (fetchDocuments) — the raw shape of one row from the documents table lookup. Also internal/unexported.
interface DocumentRow extends Record<string, unknown> {
  id: number;
  url: string;
  title: string;
}

//Purpose: the public, camelCase-friendly shape describing "enough of a document to render one line of search results"
export interface DocumentSummary {
  id: number;
  url: string;
  title: string;
}

/**
 * Fetch the posting lists for a query's stems, with the document lengths BM25 needs.
 *
 * One round trip for the whole query rather than one per term: the posting lists are read
 * together, grouped in memory, and handed to the scorer. `positions` is deliberately not
 * selected — the ranker never reads it, and it is the wide column.
 *
 * Returned in the order the stems were given, so `--explain` output and the tests read in
 * query order rather than in whatever order Postgres felt like. Stems with no row in `terms`
 * are simply absent; a term nothing contains has no posting list to score.
 */
export async function fetchTermPostings(
  db: Queryable,
  stems: readonly string[],
): Promise<TermPostings[]> {
  //Deduped here as well as in the scorer. `scoreDocuments` throws on a repeated term, and
  //without this a caller who forgot would turn that into a thrown error rather than the
  //no-op it should be — plus the same posting list would be fetched twice.
  const terms = uniqueTerms([...stems]);
  if (terms.length === 0) return [];

  const { rows } = await db.query<PostingRow>(
    `SELECT t.term, t.doc_freq, p.doc_id, p.tf, d.token_count
       FROM terms t
       JOIN postings p ON p.term_id = t.id
       JOIN documents d ON d.id = p.doc_id
      WHERE t.term = ANY($1::text[])
      ORDER BY t.term, p.doc_id`,
    [terms],
  );
/*
  Say stems = ["cat", "xyz", "dog"] ("xyz" matches nothing in the corpus).

uniqueTerms → ["cat", "xyz", "dog"] (already unique, order preserved).
SQL returns, say:
   term="cat", doc_freq=2, doc_id=1, tf=3, token_count=100
   term="cat", doc_freq=2, doc_id=2, tf=1, token_count=50
   term="dog", doc_freq=1, doc_id=1, tf=1, token_count=100

(No rows for "xyz" — it's not in terms at all.)
3. byTerm after grouping:

   "cat" → { docFreq: 2, postings: [{docId:1,tf:3,docLength:100}, {docId:2,tf:1,docLength:50}] }
   "dog" → { docFreq: 1, postings: [{docId:1,tf:1,docLength:100}] }
  
  */ 
  const byTerm = new Map<string, { docFreq: number; postings: ScorablePosting[] }>();

  for (const row of rows) {
    let entry = byTerm.get(row.term);

    if (entry === undefined) {
      entry = { docFreq: row.doc_freq, postings: [] };
      byTerm.set(row.term, entry);
    }

    entry.postings.push({ docId: row.doc_id, tf: row.tf, docLength: row.token_count });
  }

  /*
Final ordered (looping ["cat", "xyz", "dog"], skipping "xyz" since it's absent from byTerm):
   [
     { term: "cat", docFreq: 2, postings: [...] },
     { term: "dog", docFreq: 1, postings: [...] }
   ]
  */  
//Reordering to match the caller's input order:
  const ordered: TermPostings[] = [];
  for (const term of terms) {
    const entry = byTerm.get(term);
    if (entry !== undefined) {
      ordered.push({ term, docFreq: entry.docFreq, postings: entry.postings });
    }
  }

  return ordered;
}

//Purpose of this function: given a list of document IDs (the winners, after rankDocuments has already sorted and trimmed to a page), 
// fetch the actual human-readable details (url, title) needed to display them as search results.
export async function fetchDocuments(
  db: Queryable,
  ids: readonly number[],
): Promise<Map<number, DocumentSummary>> {
  if (ids.length === 0) return new Map();

  const { rows } = await db.query<DocumentRow>(
    `SELECT id, url, title FROM documents WHERE id = ANY($1::int[])`,
    [[...ids]],
  );

  return new Map(rows.map((row) => [row.id, { id: row.id, url: row.url, title: row.title }]));
}
