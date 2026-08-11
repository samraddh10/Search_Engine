/**
 * Phase 1.6 persistence: a durable record of the URLs the crawl could not fetch, plus the
 * self-reported canonical URL of the pages it could.
 *
 * Raw SQL for the same reason as the initial migration — the DDL stays readable and stays
 * in step with db/schema.sql.
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
    -- Recorded, never obeyed. The fetcher's final post-redirect URL stays the document's
    -- identity: a broken template emitting <link rel="canonical" href="/"> on every page
    -- would otherwise collapse a whole site into a single row, and that loss is silent
    -- and unrecoverable. Duplicates are recoverable, and content_hash already catches
    -- them. Kept because the value exists only while the crawl is running.
    ALTER TABLE documents ADD COLUMN canonical_url TEXT;

    CREATE TABLE crawl_errors (
      -- The URL is the natural key: one row per failing URL, upserted on each further
      -- attempt. No SERIAL id because nothing references this table by foreign key, and
      -- ON CONFLICT (url) needs this unique index anyway.
      url           TEXT        PRIMARY KEY,
      reason        TEXT        NOT NULL,
      http_status   INTEGER,
      detail        TEXT,
      depth         INTEGER     NOT NULL DEFAULT 0,
      -- Counts scheduling rounds that ended in failure, not HTTP requests: fetchPage has
      -- already spent its own retries before the scheduler ever sees a failure.
      attempts      INTEGER     NOT NULL DEFAULT 1,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    COMMENT ON TABLE crawl_errors IS
      'URLs the crawler failed on, so a later run can re-seed exactly what broke. A row is '
      'deleted when its URL is later stored successfully, so the table describes the '
      'current gaps in the corpus rather than a full history.';
    COMMENT ON COLUMN crawl_errors.reason IS
      'A FetchFailureReason (timeout, http-error, too-large, ...) or "parse-failed".';

    -- No index beyond the primary key: this table is read by a human asking "what broke?"
    -- across a few hundred rows, and every extra index is write cost on the crawl's hot
    -- path.
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS crawl_errors;
    ALTER TABLE documents DROP COLUMN IF EXISTS canonical_url;
  `);
};
