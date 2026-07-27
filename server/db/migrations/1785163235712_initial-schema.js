/**
 * Initial schema: documents, terms, postings, corpus_stats.
 *
 * Written as raw SQL rather than node-pg-migrate's declarative helpers so the DDL stays
 * readable and stays in step with db/schema.sql, which mirrors it for quick reference.
 * Migrations are the source of truth; schema.sql is a convenience snapshot.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
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

    -- The crawler dedupes on content_hash (same page reachable via two URLs), so that
    -- lookup happens once per fetched page and wants an index. Not UNIQUE: two genuinely
    -- distinct URLs may legitimately share content, and we keep both rows.
    CREATE INDEX documents_content_hash_idx ON documents (content_hash);

    CREATE TABLE terms (
      id           SERIAL  PRIMARY KEY,
      term         TEXT    NOT NULL UNIQUE,
      doc_freq     INTEGER NOT NULL DEFAULT 0,
      surface_form TEXT
    );

    COMMENT ON COLUMN terms.term IS
      'The stemmed token, e.g. "comput". This is what postings join on.';
    COMMENT ON COLUMN terms.surface_form IS
      'Most frequently observed original spelling for this stem, e.g. "computer". '
      'Populated by the indexer (Phase 2); autocomplete displays and prefix-matches on '
      'COALESCE(surface_form, term) so it never surfaces raw stems to users.';

    CREATE TABLE postings (
      term_id   INTEGER   NOT NULL REFERENCES terms (id) ON DELETE CASCADE,
      doc_id    INTEGER   NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
      tf        INTEGER   NOT NULL,
      positions INTEGER[] NOT NULL DEFAULT '{}',
      PRIMARY KEY (term_id, doc_id)
    );

    -- No separate index on term_id: the primary key's btree is on (term_id, doc_id), and
    -- a leading-column lookup already uses it. That covers query time ("all docs holding
    -- term X"). doc_id is the other direction — deleting or reindexing a single document
    -- — and does need its own index.
    CREATE INDEX postings_doc_id_idx ON postings (doc_id);

    CREATE TABLE corpus_stats (
      id           INTEGER          PRIMARY KEY DEFAULT 1,
      total_docs   INTEGER          NOT NULL DEFAULT 0,
      total_tokens BIGINT           NOT NULL DEFAULT 0,
      avg_doc_len  DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
      CONSTRAINT corpus_stats_single_row CHECK (id = 1)
    );

    -- BM25 reads these on every query, so the row must always exist: seed it here and let
    -- the indexer UPDATE it. The CHECK above makes a second row impossible.
    INSERT INTO corpus_stats (id) VALUES (1);
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  // Reverse dependency order: postings references both terms and documents.
  pgm.sql(`
    DROP TABLE IF EXISTS postings;
    DROP TABLE IF EXISTS corpus_stats;
    DROP TABLE IF EXISTS terms;
    DROP TABLE IF EXISTS documents;
  `);
};
