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

async function seed(): Promise<void> {
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
    console.error("Seed failed", err);
    process.exitCode = 1;
  })
  // Swallow a close failure: the pool is being torn down anyway, and an unhandled
  // rejection here would mask the real seed error reported above.
  .finally(() => closePg().catch(() => {}));
