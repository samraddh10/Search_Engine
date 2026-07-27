-- Canonical snapshot of the current schema, for reading and for bootstrapping a database
-- without the migration tool:  psql -U postgres -d search_engine -f db/schema.sql
--
-- NOT the source of truth: db/migrations/ is. Applying migrations is what a real
-- environment does; this file mirrors their end state. If you change the schema, add a
-- migration and update this file to match — nothing enforces that they agree.

CREATE TABLE documents (
  id           SERIAL      PRIMARY KEY,
  url          TEXT        NOT NULL UNIQUE,
  title        TEXT        NOT NULL DEFAULT '',
  content_text TEXT        NOT NULL,
  content_hash TEXT        NOT NULL,
  http_status  INTEGER     NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  token_count  INTEGER     NOT NULL DEFAULT 0,
  lang         TEXT
);

-- Crawler dedupe path. Not UNIQUE: distinct URLs may legitimately share content.
CREATE INDEX documents_content_hash_idx ON documents (content_hash);

CREATE TABLE terms (
  id           SERIAL  PRIMARY KEY,
  term         TEXT    NOT NULL UNIQUE,  -- stemmed token, e.g. 'comput'
  doc_freq     INTEGER NOT NULL DEFAULT 0,
  surface_form TEXT                      -- display spelling, e.g. 'computer'
);

CREATE TABLE postings (
  term_id   INTEGER   NOT NULL REFERENCES terms (id) ON DELETE CASCADE,
  doc_id    INTEGER   NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  tf        INTEGER   NOT NULL,
  positions INTEGER[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (term_id, doc_id)
);

-- Query time ("docs containing term X") is served by the PK's leading column. This index
-- covers the reverse direction: delete/reindex one document.
CREATE INDEX postings_doc_id_idx ON postings (doc_id);

CREATE TABLE corpus_stats (
  id           INTEGER          PRIMARY KEY DEFAULT 1,
  total_docs   INTEGER          NOT NULL DEFAULT 0,
  -- node-postgres returns BIGINT as a *string*, not a number, to avoid silent precision
  -- loss past 2^53. Any TypeScript type for this column must be `string` (or parse
  -- explicitly) — `number` will typecheck and then be wrong at runtime.
  total_tokens BIGINT           NOT NULL DEFAULT 0,
  avg_doc_len  DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CONSTRAINT corpus_stats_single_row CHECK (id = 1)
);

INSERT INTO corpus_stats (id) VALUES (1);
