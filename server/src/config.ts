import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  // Optional on purpose. Redis only backs the crawl frontier + robots cache, and the
  // crawler is a local/offline job — the hosted API never talks to Redis (its result
  // cache and autocomplete live in-process). So an unset REDIS_URL is a valid
  // production configuration, not a misconfiguration. See docs/project-plan.md
  // ("Hosting model").
  REDIS_URL: z.string().url().optional(),
});

// safeParse rather than parse: this runs at import time, so a thrown ZodError would
// escape before main()'s catch in index.ts exists and surface as an unformatted stack
// trace. A misconfigured .env is the single most likely startup failure, so it deserves
// a message that says which variable is wrong.
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  console.error(
    `Invalid environment configuration:\n${details}\n\n` +
      `Check server/.env against server/.env.example.`,
  );
  process.exit(1);
}

export const config = parsed.data;
