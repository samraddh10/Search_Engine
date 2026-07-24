import Redis from "ioredis";
import { config } from "../config";

export const redisClient = new Redis(config.REDIS_URL, {
// lazyConnect: true — without this, ioredis connects the instant `new Redis()`
  // runs (at import time), before the app has finished booting. If Redis/Docker
  // isn't up yet, that throws immediately and can crash startup.
  // With lazyConnect, no connection is attempted until the first real command
  // (e.g. checkRedisHealth's .ping()) — so the app can boot even if Redis
  // isn't ready yet, and only that first Redis-dependent call fails/retries.
});

redisClient.on("error", (err) => {
  console.error("Redis client error", err);
});

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const pong = await redisClient.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await redisClient.quit();
}
