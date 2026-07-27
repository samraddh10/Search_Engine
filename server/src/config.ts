import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  // Optional on purpose. Redis only backs the crawl frontier + robots cache, and the
  // crawler is a local/offline job — the hosted API never talks to Redis (its result
  // cache and autocomplete live in-process). So an unset REDIS_URL is a valid
  // production configuration, not a misconfiguration. See docs/project-plan.md
  // ("Hosting model").
  REDIS_URL: z.string().url().optional(),
});

export const config = envSchema.parse(process.env);
