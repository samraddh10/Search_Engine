//createHash — a built-in Node.js tool for generating a hash.
import { createHash } from "node:crypto";
import type { CrawledPage, CrawlFailure } from "./scheduler.js";

export const STORE_DEFAULTS = {
  minContentChars: 1,
  maxDetailChars: 500,
  //as const tells TypeScript to treat these as fixed literal values rather than generic numbers — a minor strictness improvement.
} as const;

export interface Queryable {
  query<R extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

export type StoreRejection = "noindex" | "duplicate" | "empty";

export type StoreOutcome =
  | { stored: true; id: number; action: "inserted" | "updated"; url: string; contentHash: string }
  | { stored: false; reason: StoreRejection; url: string };

export interface DocumentStoreStats {
  inserted: number;
  updated: number;
  duplicate: number;
  noindex: number;
  empty: number;
  failuresRecorded: number;
  errorsCleared: number;
}

export interface DocumentStoreOptions {
  minContentChars?: number;
  maxDetailChars?: number;
}

export function contentHash(title: string, text: string): string {
  //createHash("sha256") — starts hashing using SHA-256, a standard, collision-resistant algorithm
  //.digest("hex") — finishes the hash and returns it as a hex string (digits 0–9 and letters a–f) — the readable fingerprint.
  return createHash("sha256").update(`${title}\n${text}`, "utf8").digest("hex");
}

export class DocumentStore {
  readonly #db: Queryable;
  readonly #minContentChars: number;
  readonly #maxDetailChars: number;
  readonly #stats: DocumentStoreStats = {
    inserted: 0,
    updated: 0,
    duplicate: 0,
    noindex: 0,
    empty: 0,
    failuresRecorded: 0,
    errorsCleared: 0,
  };

  constructor(db: Queryable, options: DocumentStoreOptions = {}) {
    this.#db = db;
    this.#minContentChars = options.minContentChars ?? STORE_DEFAULTS.minContentChars;
    this.#maxDetailChars = options.maxDetailChars ?? STORE_DEFAULTS.maxDetailChars;
  }

  async storePage(crawled: CrawledPage): Promise<StoreOutcome> {
    const { page } = crawled;

    const url = page.url;

    if (page.noindex) {
      this.#stats.noindex++;
      await this.#db.query("DELETE FROM documents WHERE url = $1", [url]);

      return { stored: false, reason: "noindex", url };
    }

    const text = page.text.trim();
    if (text.length < this.#minContentChars) {
      this.#stats.empty++;
      return { stored: false, reason: "empty", url };
    }

    const hash = contentHash(page.title, text);

    const { rows } = await this.#db.query<{ id: number; inserted: boolean }>(
      `INSERT INTO documents
         (url, title, content_text, content_hash, http_status, fetched_at, lang, canonical_url)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
        WHERE EXISTS (SELECT 1 FROM documents WHERE url = $1)
           OR NOT EXISTS (SELECT 1 FROM documents WHERE content_hash = $4)
       ON CONFLICT (url) DO UPDATE SET
         title         = EXCLUDED.title,
         content_text  = EXCLUDED.content_text,
         content_hash  = EXCLUDED.content_hash,
         http_status   = EXCLUDED.http_status,
         fetched_at    = EXCLUDED.fetched_at,
         lang          = EXCLUDED.lang,
         canonical_url = EXCLUDED.canonical_url,
         token_count   = CASE
                           WHEN documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                           THEN 0
                           ELSE documents.token_count
                         END
       RETURNING id, (xmax = 0) AS inserted`,
      [
        url,
        page.title,
        text,
        hash,
        crawled.status,
        crawled.fetchedAt,
        page.lang,
        page.canonicalUrl,
      ],
    );

    const row = rows[0];
    if (!row) {
      this.#stats.duplicate++;
      return { stored: false, reason: "duplicate", url };
    }

    const action = row.inserted ? "inserted" : "updated";
    this.#stats[action]++;

    await this.#clearErrors([url, crawled.requestedUrl, crawled.url]);

    return { stored: true, id: row.id, action, url, contentHash: hash };
  }

  async recordFailure(failure: CrawlFailure): Promise<void> {
    this.#stats.failuresRecorded++;

    await this.#db.query(
      `INSERT INTO crawl_errors (url, reason, http_status, detail, depth, attempts)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (url) DO UPDATE SET
         reason       = EXCLUDED.reason,
         http_status  = EXCLUDED.http_status,
         detail       = EXCLUDED.detail,
         depth        = LEAST(crawl_errors.depth, EXCLUDED.depth),
         attempts     = crawl_errors.attempts + EXCLUDED.attempts,
         last_seen_at = now()`,
      [
        failure.url,
        failure.reason,
        failure.status ?? null,
        failure.detail.slice(0, this.#maxDetailChars),
        failure.depth,
        failure.rounds,
      ],
    );
  }

  get stats(): DocumentStoreStats {
    return { ...this.#stats };
  }

  async #clearErrors(urls: readonly string[]): Promise<void> {
    const distinct = [...new Set(urls)];

    const { rowCount } = await this.#db.query("DELETE FROM crawl_errors WHERE url = ANY($1)", [
      distinct,
    ]);

    this.#stats.errorsCleared += rowCount ?? 0;
  }
}
