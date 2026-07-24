import { Pool } from "pg";
import { config } from "../config";

export const pgPool = new Pool({ connectionString: config.DATABASE_URL });

pgPool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
});

export async function checkPgHealth(): Promise<boolean> {
  try {
    await pgPool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function closePg(): Promise<void> {
  await pgPool.end();
}
