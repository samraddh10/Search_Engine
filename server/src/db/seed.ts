import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closePg, pgPool } from "./pg.js";

// ESM has no __dirname. Deriving it from import.meta.url means the script finds seed.sql
// no matter which directory npm invokes it from.
const here = dirname(fileURLToPath(import.meta.url));

async function seed(): Promise<void> {
  const sql = await readFile(join(here, "seed.sql"), "utf8");

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
  .finally(closePg);
