-- Small, hand-written fixture corpus: three documents and the postings that would result
-- from indexing them. Lets you exercise queries before the crawler and indexer exist, and
-- gives Phase 5 a deterministic dataset to assert against.
--
-- Re-runnable: truncating first means `npm run seed` twice leaves the same state.
-- Numbers here are illustrative but internally consistent — doc_freq matches the posting
-- counts, and corpus_stats matches the documents — so BM25 can be hand-checked later.

TRUNCATE postings, terms, documents RESTART IDENTITY CASCADE;

INSERT INTO documents (url, title, content_text, content_hash, http_status, token_count, lang) VALUES
  ('https://example.test/crawlers',
   'Introduction to Web Crawlers',
   'A web crawler fetches pages and follows links. The crawler respects robots rules and queues each discovered link before fetching it.',
   'hash_crawlers_001', 200, 120, 'en'),
  ('https://example.test/inverted-index',
   'Building an Inverted Index',
   'An inverted index maps each term to the documents containing it. Indexing a document means tokenizing its text and recording positions.',
   'hash_index_002', 200, 200, 'en'),
  ('https://example.test/bm25',
   'Ranking Documents with BM25',
   'BM25 ranks documents by term frequency and inverse document frequency. Ranking also normalizes for document length.',
   'hash_bm25_003', 200, 160, 'en');

-- term = stem (what postings join on); surface_form = spelling shown to users.
-- Note 'crawl'/'crawler' and 'index'/'indexing' — this pair is exactly why surface_form
-- exists: without it autocomplete would suggest the bare stems.
INSERT INTO terms (term, doc_freq, surface_form) VALUES
  ('crawl',    1, 'crawler'),   -- id 1
  ('index',    1, 'index'),     -- id 2
  ('rank',     1, 'ranking'),   -- id 3
  ('document', 3, 'documents'), -- id 4  (appears in all three)
  ('term',     2, 'term');      -- id 5

INSERT INTO postings (term_id, doc_id, tf, positions) VALUES
  (1, 1, 2, '{1,14}'),           -- crawl   -> doc 1
  (2, 2, 2, '{2,17}'),           -- index   -> doc 2
  (3, 3, 2, '{1,16}'),           -- rank    -> doc 3
  (4, 1, 1, '{9}'),              -- document -> all three docs
  (4, 2, 2, '{8,19}'),
  (4, 3, 3, '{3,11,20}'),
  (5, 2, 1, '{5}'),              -- term    -> docs 2 and 3
  (5, 3, 1, '{6}');

-- total_tokens = 120 + 200 + 160; avg_doc_len = 480 / 3
UPDATE corpus_stats
   SET total_docs = 3, total_tokens = 480, avg_doc_len = 160, updated_at = now()
 WHERE id = 1;
