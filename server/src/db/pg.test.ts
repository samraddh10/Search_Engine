import { afterAll, describe, expect, it } from "vitest";
import { checkPgHealth, closePg, pgPool } from "./pg.js";

//closes the pool once all tests finish so the process doesn't hang on an open connection 
// and so connections aren't leaked between test files.
afterAll(closePg);

//Test 1 — Basic health check
//This is a sanity check that the connection pool is actually live and able to talk to Postgres
describe("Postgres connection", () => {
  it("reports healthy against a reachable database", async () => {
    await expect(checkPgHealth()).resolves.toBe(true);
  });

  // The most important assertion in the suite: if the env wiring ever regresses, tests
  // would silently truncate the development database instead of the test one.
  // Test 2 — The critical safety check
  it("is connected to the test database, not the development one", async () => {
    const { rows } = await pgPool.query<{ current_database: string }>(
      "SELECT current_database()",
    );

    expect(rows[0].current_database).toBe("search_engine_test");
  });

  //Test 3 — Verifying migrations ran
  //The test iscanc confirming an infrastructure precondition: that the expected tables actually exist
  it("has the migrated schema, proving globalSetup ran the migrations", async () => {
    const { rows } = await pgPool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'`,
    );

    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["corpus_stats", "documents", "postings", "terms"]),
    );
  });

  //Test 4 — Database constraint enforcement, checks if corpus have single row or multiple row.
  it("enforces the single-row constraint on corpus_stats", async () => {
    await expect(pgPool.query("INSERT INTO corpus_stats (id) VALUES (2)")).rejects.toThrow(
      /corpus_stats_single_row/,
    );
  });
});
