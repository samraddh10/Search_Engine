import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// redis.ts decides whether to build a client at *module load*, from config.REDIS_URL.
// Testing both branches therefore means resetting the module registry between cases and
// re-importing, rather than calling a function with different arguments.

//before each test, wipe vitest's module cache. 
//This forces the next import("./redis.js") to run the file fresh, 
//from scratch — so it re-checks the environment variable at that moment.
beforeEach(() => {
  vi.resetModules();
});

//after each test, undo any fake environment variables set during the test, 
//so tests don't leak settings into each other.
afterEach(() => {
  vi.unstubAllEnvs();
});

//Test group 1: No REDIS_URL set (hosted/production configuration)
//Test 1 — No client gets built, and health reports the right special value
describe("without REDIS_URL (the hosted configuration)", () => {
  it("builds no client and reports \"not_configured\" rather than false", async () => {
    const { checkRedisHealth, redisClient } = await import("./redis.js");

    expect(redisClient).toBeNull();
    // The distinction matters: "not_configured" keeps /api/health green, false does not.
    await expect(checkRedisHealth()).resolves.toBe("not_configured");
  });

  //Test 2 — Connect/close don't throw when there's nothing to connect to
  it("makes connect and close no-ops instead of throwing", async () => {
    const { closeRedis, connectRedis } = await import("./redis.js");

    await expect(connectRedis()).resolves.toBeUndefined();
    await expect(closeRedis()).resolves.toBeUndefined();
  });
});

//Test group 2: REDIS_URL is set (local crawl configuration)
describe("with REDIS_URL set (the local crawl configuration)", () => {
  it("builds a client and reports true against a reachable Redis", async () => {

    //fakes the environment variable so it looks like Redis is configured, 
    // pointing at a local Redis instance.
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");

    const { checkRedisHealth, closeRedis, connectRedis, redisClient } = await import(
      "./redis.js"
    );

    expect(redisClient).not.toBeNull();

    // lazyConnect means nothing has dialled Redis yet; this is also the regression test
    // for the bug where an eager connect made this call reject with
    // "Redis is already connecting/connected".
    await connectRedis();
    await expect(checkRedisHealth()).resolves.toBe(true);

    await closeRedis();
  });
});
