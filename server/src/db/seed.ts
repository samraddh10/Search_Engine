import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePg, pgPool } from "./pg.js";

// ESM has no __dirname. Deriving it from import.meta.url means the script finds seed.sql
// no matter which directory npm invokes it from.
//
// "../../db" resolves to server/db/ from *both* src/db/ (via tsx) and dist/db/ (after a
// build), because both are two levels below the workspace root. Keeping the .sql outside
// src/ is deliberate: tsc only emits .ts, so a seed.sql living next to this file would
// never be copied into dist/ and the built script would fail with ENOENT.
const here = dirname(fileURLToPath(import.meta.url));
const seedFile = join(here, "..", "..", "db", "seed.sql");

// Every fixture document uses this host (see db/seed.sql), so anything outside it was put
// there by a real crawl. Checked against the URL rather than a row count because a crawl
// could coincidentally produce three documents.
const FIXTURE_URL_PREFIX = "https://example.test/";

const force = process.argv.includes("--force");

/**
 * seed.sql opens with TRUNCATE, which is correct for a reproducible fixture and disastrous
 * for a real corpus — a crawl can take hours, and `npm run seed` is one keystroke away
 * from `npm run start`. Refuse when the table holds anything that isn't fixture data.
 */
async function assertSafeToSeed(): Promise<void> {
  let crawled: number;

  try {
    const { rows } = await pgPool.query<{ count: string }>(
      "SELECT count(*) AS count FROM documents WHERE url NOT LIKE $1",
      [`${FIXTURE_URL_PREFIX}%`],
    );
    crawled = Number(rows[0].count);
  } catch (err) {
    // 42P01 = undefined_table: migrations haven't run, so there is nothing to protect.
    // Let the seed itself fail with its own, clearer error.
    if ((err as { code?: string }).code === "42P01") return;
    throw err;
  }

  if (crawled === 0) return;

  if (force) {
    console.warn(`--force: overwriting ${crawled} crawled document(s).`);
    return;
  }

  throw new Error(
    `Refusing to seed: documents contains ${crawled} row(s) that did not come from the ` +
      `fixture, which looks like real crawled data. Seeding TRUNCATEs the table.\n` +
      `If you are sure, re-run with:  npm run seed -- --force\n` +
      `(the root script ends in "--" so the flag is forwarded; without it npm would ` +
      `consume --force as its own option)`,
  );
}

async function seed(): Promise<void> {
  await assertSafeToSeed();

  const sql = await readFile(seedFile, "utf8");

  // One query() call with several statements runs as a single implicit transaction, so a
  // failure part-way leaves the tables as they were rather than half-seeded.
  await pgPool.query(sql);

  const { rows } = await pgPool.query<{ documents: string; terms: string; postings: string }>(`
    SELECT (SELECT count(*) FROM documents) AS documents,
           (SELECT count(*) FROM terms)     AS terms,
           (SELECT count(*) FROM postings)  AS postings
  `);

  const { documents, terms, postings } = rows[0];
  console.log(`Seeded: ${documents} documents, ${terms} terms, ${postings} postings`);
}

seed()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  // Swallow a close failure: the pool is being torn down anyway, and an unhandled
  // rejection here would mask the real seed error reported above.
  .finally(() => closePg().catch(() => {}));
