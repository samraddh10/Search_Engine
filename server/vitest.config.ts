import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const envTestPath = join(here, ".env.test");

const parsed = loadEnv({ path: envTestPath }).parsed;
if (!parsed) {
  throw new Error(
    `Missing ${envTestPath}. Copy server/.env.test.example to server/.env.test to set up the test database.`,
  );
}
const testEnv = parsed;

export default defineConfig({
  test: {
    env: {
      ...testEnv,
      // src/config.ts calls `import "dotenv/config"`, which resolves .env from the cwd —
      // the *development* file, where REDIS_URL is set. Redirecting dotenv at .env.test
      // is what keeps "no Redis configured" genuinely unconfigured during tests, and
      // doubly guarantees DATABASE_URL cannot fall back to the dev database.
      DOTENV_CONFIG_PATH: envTestPath,
    },
    globalSetup: ["./test/globalSetup.ts"],
    include: ["src/**/*.test.ts"],
    // Every DB-backed test shares one Postgres database. Running files in parallel would
    // let one file's writes land in the middle of another's assertions.
    fileParallelism: false,
  },
});
