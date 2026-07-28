import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { runner } from "node-pg-migrate";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "db", "migrations");

// globalSetup runs in Vitest's main process, which the `test.env` block in
// vitest.config.ts does not reach — that applies to test workers. So load .env.test here
// too rather than assuming DATABASE_URL is already present.
loadEnv({ path: join(here, "..", ".env.test") });

/**
 * Runs once before the whole suite: makes sure the test database exists and is migrated
 * to the current schema. Tests then get a real Postgres with the real DDL — the same
 * migrations production runs — rather than a mock that can drift from it.
 */
export default async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — check server/.env.test");
  }

  const parsed = new URL(databaseUrl);
  const dbName = decodeURIComponent(parsed.pathname.slice(1));

  // The guard that makes this safe to run repeatedly. globalSetup creates and migrates
  // whatever database the URL names, and the tests truncate tables freely, so pointing at
  // `search_engine` by accident would destroy development data. Requiring the _test
  // suffix makes that mistake impossible rather than merely unlikely.
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `Refusing to run tests against database "${dbName}": the name must end in "_test". ` +
        `Check DATABASE_URL in server/.env.test.`,
    );
  }

  await createDatabaseIfMissing(parsed, dbName);

  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: "up",
    migrationsTable: "pgmigrations",
    // The suite prints its own output; migration SQL would drown it.
    log: () => {},
  });
}

/**
 * CREATE DATABASE cannot run inside a transaction and cannot target the database you are
 * connected to, so this connects to the always-present `postgres` maintenance database
 * instead.
 */
async function createDatabaseIfMissing(parsed: URL, dbName: string): Promise<void> {
  const adminUrl = new URL(parsed.toString());
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      dbName,
    ]);

    if (rowCount === 0) {
      // Identifiers cannot be parameterised, so quote it properly instead of interpolating.
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(dbName)}`);
      console.log(`Created test database "${dbName}"`);
    }
  } finally {
    await admin.end();
  }
}
