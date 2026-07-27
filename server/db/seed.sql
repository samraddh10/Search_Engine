-- Small, hand-written fixture corpus: three documents and the postings that would result
-- from indexing them. Lets you exercise queries before the crawler and indexer exist, and
-- gives Phase 5 a deterministic dataset to assert against.
--
-- Re-runnable: truncating first means `npm run seed` twice leaves the same state.
--
-- Every number below is derived from the actual content_text, not invented:
--   * token_count is the real whitespace-token count of that document
--   * positions are 1-indexed offsets into that same token stream
--   * tf equals the length of the positions array
--   * doc_freq equals the number of postings for that term
--   * corpus_stats matches the documents (18 + 18 + 14 = 50 tokens over 3 docs)
-- This matters because Phase 3.2 builds snippets by slicing content_text around these
-- positions — if they were decorative, snippet tests would silently produce garbage.
--
-- NOTE ON POSITIONS AND STOPWORDS: these are positions in the *raw* token stream, before
-- stopword removal ("a", "the", "and", ...). Phase 2.1 must keep original positions when
-- it filters stopwords, rather than renumbering the surviving tokens, or snippets will
-- point at the wrong words.

TRUNCATE postings, terms, documents RESTART IDENTITY CASCADE;

INSERT INTO documents (url, title, content_text, content_hash, http_status, token_count, lang) VALUES
  -- 18 tokens: a(1) web(2) crawler(3) fetches(4) documents(5) and(6) follows(7) links(8)
  --            the(9) crawler(10) respects(11) robots(12) rules(13) and(14) queues(15)
  --            each(16) discovered(17) document(18)
  ('https://example.test/crawlers',
   'Introduction to Web Crawlers',
   'A web crawler fetches documents and follows links. The crawler respects robots rules and queues each discovered document',
   'hash_crawlers_001', 200, 18, 'en'),

  -- 18 tokens: an(1) inverted(2) index(3) maps(4) each(5) term(6) to(7) the(8)
  --            documents(9) containing(10) it(11) indexing(12) a(13) document(14)
  --            means(15) indexing(16) its(17) positions(18)
  ('https://example.test/inverted-index',
   'Building an Inverted Index',
   'An inverted index maps each term to the documents containing it. Indexing a document means indexing its positions',
   'hash_index_002', 200, 18, 'en'),

  -- 14 tokens: bm25(1) ranking(2) scores(3) documents(4) by(5) term(6) frequency(7)
  --            ranking(8) also(9) normalizes(10) each(11) document(12) by(13) length(14)
  ('https://example.test/bm25',
   'Ranking Documents with BM25',
   'BM25 ranking scores documents by term frequency. Ranking also normalizes each document by length',
   'hash_bm25_003', 200, 14, 'en');

-- term = stem (what postings join on); surface_form = the spelling shown to users.
-- Three stems here differ from their display form — crawl/crawler, index/indexing,
-- rank/ranking — which is exactly why surface_form exists: without it, autocomplete would
-- suggest the bare stems. surface_form is the most frequent original spelling; ties break
-- shortest-then-lexicographic, which is why 'document' (3x) beats 'documents' (3x).
INSERT INTO terms (term, doc_freq, surface_form) VALUES
  ('crawl',    1, 'crawler'),   -- id 1
  ('index',    1, 'indexing'),  -- id 2  ('indexing' 2x vs 'index' 1x in doc 2)
  ('rank',     1, 'ranking'),   -- id 3
  ('document', 3, 'document'),  -- id 4  (appears in all three documents)
  ('term',     2, 'term');      -- id 5

INSERT INTO postings (term_id, doc_id, tf, positions) VALUES
  (1, 1, 2, '{3,10}'),      -- crawl:    doc 1 "crawler" x2
  (2, 2, 3, '{3,12,16}'),   -- index:    doc 2 "index", "indexing" x2
  (3, 3, 2, '{2,8}'),       -- rank:     doc 3 "ranking" x2
  (4, 1, 2, '{5,18}'),      -- document: doc 1 "documents", "document"
  (4, 2, 2, '{9,14}'),      -- document: doc 2 "documents", "document"
  (4, 3, 2, '{4,12}'),      -- document: doc 3 "documents", "document"
  (5, 2, 1, '{6}'),         -- term:     doc 2
  (5, 3, 1, '{6}');         -- term:     doc 3

-- Upsert rather than UPDATE: a bare UPDATE silently affects zero rows if the singleton
-- row is ever missing, which would leave BM25 with no corpus statistics while the seed
-- still reported success.
INSERT INTO corpus_stats (id, total_docs, total_tokens, avg_doc_len)
VALUES (1, 3, 50, 50.0 / 3)
ON CONFLICT (id) DO UPDATE
   SET total_docs   = EXCLUDED.total_docs,
       total_tokens = EXCLUDED.total_tokens,
       avg_doc_len  = EXCLUDED.avg_doc_len,
       updated_at   = now();
