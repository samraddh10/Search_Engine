// Named import, not default: under NodeNext, ioredis's CJS `export =` shape doesn't
// resolve to a constructable default. `{ Redis }` is the form ioredis v5 documents.
import { Redis } from "ioredis";
import { config } from "../config.js";

// Redis is optional. It backs the crawl frontier + robots cache, which only run in the
// local/offline crawl job; the hosted API has no Redis at all. So this module exports a
// *nullable* client — `null` means "not configured", which is a normal state, not a
// failure. Consumers must null-check, which is exactly why there's no separate
// `isRedisConfigured` boolean: a boolean wouldn't narrow the type for TypeScript, so
// call sites would still need the check and could be fooled into skipping it.
const redisUrl = config.REDIS_URL;

export const redisClient = redisUrl
  ? new Redis(redisUrl, {
      // lazyConnect: true — without this, ioredis connects the instant `new Redis()`
      // runs (at import time), before the app has finished booting. If Redis/Docker
      // isn't up yet, that throws immediately and can crash startup.
      // With lazyConnect, no connection is attempted until connectRedis() (or the first
      // real command) — so the app can boot even if Redis isn't ready yet, and only that
      // first Redis-dependent call fails/retries.
      lazyConnect: true,
    })
  : null;

redisClient?.on("error", (err) => {
  console.error("Redis client error", err);
});

// `false` = configured but unreachable (a real problem). "not_configured" = intentionally
// absent (fine). Keeping these distinct is what lets /api/health stay green when the
// hosted deployment runs without Redis, while still going degraded if a Redis we *expect*
// has gone down.
export type RedisHealth = boolean | "not_configured";

export async function checkRedisHealth(): Promise<RedisHealth> {
  if (!redisClient) return "not_configured";

  try {
    const pong = await redisClient.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

export async function connectRedis(): Promise<void> {
  if (!redisClient) {
    console.log(
      "REDIS_URL not set — running without Redis (crawler unavailable; " +
        "API cache + autocomplete are in-process)",
    );
    return;
  }

  await redisClient.connect();
}

export async function closeRedis(): Promise<void> {
  if (!redisClient) return;

  await redisClient.quit();
}
