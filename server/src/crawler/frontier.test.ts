import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  FRONTIER_DEFAULTS,
  Frontier,
  type AddResult,
  hostsFromSeeds,
} from "./frontier.js";
import {
  type FrontierStore,
  MemoryFrontierStore,
  RedisFrontierStore,
} from "./frontierStore.js";
import { MAX_URL_LENGTH } from "./url.js";

const REDIS_TEST_URL = process.env.REDIS_TEST_URL ?? "redis://127.0.0.1:6379/1";
const TEST_KEY_PREFIX = `frontier:test:${process.pid}:`;

function expectAdded(result: AddResult): asserts result is Extract<AddResult, { added: true }> {
  expect(result.added).toBe(true);
}

describe("frontier policy", () => {
  let store: MemoryFrontierStore;

  beforeEach(() => {
    store = new MemoryFrontierStore();
  });

  function frontier(options: ConstructorParameters<typeof Frontier>[1] = {}) {
    return new Frontier(store, { allowedHosts: ["example.com"], ...options });
  }

  describe("ordering", () => {
    it("pops breadth-first, and hands back the depth it was queued at", async () => {
      const f = frontier();
      await f.addSeed("http://example.com/");
      await f.add("http://example.com/deep", { depth: 2 });
      await f.add("http://example.com/a", { depth: 1 });
      await f.add("http://example.com/b", { depth: 1 });

      expect(await f.popBatch(10)).toEqual([
        { url: "http://example.com/", depth: 0 },
        { url: "http://example.com/a", depth: 1 },
        { url: "http://example.com/b", depth: 1 },
        { url: "http://example.com/deep", depth: 2 },
      ]);
    });

    it("keeps the first (shallowest) depth when a URL is rediscovered deeper", async () => {
      const f = frontier();
      expectAdded(await f.add("http://example.com/x", { depth: 1 }));
      expect((await f.add("http://example.com/x", { depth: 3 })).added).toBe(false);

      expect(await f.next()).toEqual({ url: "http://example.com/x", depth: 1 });
    });

    it("returns null once drained", async () => {
      const f = frontier();
      await f.addSeed("http://example.com/");

      expect(await f.next()).not.toBeNull();
      expect(await f.next()).toBeNull();
      expect(await f.popBatch(5)).toEqual([]);
    });
  });

  describe("dedup", () => {
    it("rejects a URL it has already queued", async () => {
      const f = frontier();
      expectAdded(await f.addSeed("http://example.com/a"));

      const second = await f.addSeed("http://example.com/a");
      expect(second).toMatchObject({ added: false, reason: "duplicate" });
    });

    it("treats normalization-equivalent spellings as the same URL", async () => {
      for (const [first, second] of [
        ["http://example.com/a?b=2&a=1", "http://example.com/a?a=1&b=2"],
        ["http://example.com/a", "http://example.com/a#section"],
        ["http://example.com/a", "http://example.com/a?utm_source=news"],
        ["http://EXAMPLE.com/a", "http://example.com/a"],
      ]) {
        const f = new Frontier(new MemoryFrontierStore(), { allowedHosts: ["example.com"] });
        expectAdded(await f.addSeed(first!));
        expect(await f.addSeed(second!)).toMatchObject({ reason: "duplicate" });
      }
    });

    it("keeps trailing-slash variants distinct", async () => {
      const f = frontier();
      expectAdded(await f.addSeed("http://example.com/docs"));
      expectAdded(await f.addSeed("http://example.com/docs/"));

      expect(await f.size()).toBe(2);
    });

    it("markSeen blocks a later add without queuing anything", async () => {
      const f = frontier();
      expect(await f.markSeen("http://example.com/final")).toBe(true);
      expect(await f.size()).toBe(0);

      expect(await f.add("http://example.com/final", { depth: 1 })).toMatchObject({
        reason: "duplicate",
      });
    });

    it("markSeen normalizes too, and reports an unusable URL rather than marking it", async () => {
      const f = frontier();
      expect(await f.markSeen("http://example.com/a?utm_source=x#frag")).toBe(true);
      expect(await f.hasSeen("http://example.com/a")).toBe(true);

      expect(await f.markSeen("javascript:alert(1)")).toBe(false);
      expect(await f.seenCount()).toBe(1);
    });
  });

  describe("rejections", () => {
    it("rejects schemes that are not http(s), and unparseable input", async () => {
      const f = frontier();
      for (const value of ["javascript:alert(1)", "file:///etc/passwd", "not a url", ""]) {
        expect(await f.addSeed(value)).toMatchObject({
          added: false,
          reason: "invalid-url",
          url: null,
        });
      }
    });

    it("rejects URLs past the length cap", async () => {
      const f = frontier();
      const tooLong = `http://example.com/${"a".repeat(MAX_URL_LENGTH)}`;

      expect(await f.addSeed(tooLong)).toMatchObject({ reason: "invalid-url" });
    });

    it("rejects anything deeper than maxDepth, inclusive bound", async () => {
      const f = frontier({ maxDepth: 2 });

      expectAdded(await f.add("http://example.com/ok", { depth: 2 }));
      expect(await f.add("http://example.com/deep", { depth: 3 })).toMatchObject({
        reason: "too-deep",
      });
    });

    it("never queues robots.txt", async () => {
      const f = frontier();
      expect(await f.addSeed("http://example.com/robots.txt")).toMatchObject({
        reason: "excluded",
      });
    });

    it("rejects hosts outside the allowlist", async () => {
      const f = frontier();
      expect(await f.addSeed("http://other.com/a")).toMatchObject({
        added: false,
        reason: "out-of-scope",
        url: "http://other.com/a",
      });
    });
  });

  describe("scope", () => {
    it("admits both www and apex however the allowlist spells it", async () => {
      for (const allowed of ["example.com", "www.example.com"]) {
        const f = new Frontier(new MemoryFrontierStore(), { allowedHosts: [allowed] });

        expectAdded(await f.addSeed("http://example.com/a"));
        expectAdded(await f.addSeed("http://www.example.com/b"));
      }
    });

    it("does not imply other subdomains", async () => {
      const f = frontier();
      expect(await f.addSeed("http://docs.example.com/a")).toMatchObject({
        reason: "out-of-scope",
      });
    });

    it("allows every host when no allowlist is given", async () => {
      const f = new Frontier(new MemoryFrontierStore());
      expectAdded(await f.addSeed("http://anything.example.org/a"));
    });

    it("hostsFromSeeds collapses www and skips unusable seeds", () => {
      expect(
        hostsFromSeeds([
          "https://www.example.com/docs",
          "https://example.com/other",
          "https://second.org/",
          "not a url",
        ]),
      ).toEqual(["example.com", "second.org"]);
    });
  });

  describe("queue cap", () => {
    it("rejects once full without marking the URL seen", async () => {
      const f = frontier({ maxQueueSize: 2 });
      await f.addSeed("http://example.com/1");
      await f.addSeed("http://example.com/2");

      expect(await f.addSeed("http://example.com/3")).toMatchObject({ reason: "queue-full" });
      expect(await f.hasSeen("http://example.com/3")).toBe(false);

      await f.next();
      expectAdded(await f.addSeed("http://example.com/3"));
    });
  });

  describe("requeue", () => {
    it("re-adds a URL that is already marked seen", async () => {
      const f = frontier();
      expectAdded(await f.addSeed("http://example.com/flaky"));
      const popped = await f.next();
      expect(popped).not.toBeNull();

      expectAdded(await f.requeue(popped!.url, { depth: popped!.depth }));
      expect(await f.next()).toEqual({ url: "http://example.com/flaky", depth: 0 });
    });

    it("still enforces scope and depth", async () => {
      const f = frontier({ maxDepth: 1 });

      expect(await f.requeue("http://other.com/a")).toMatchObject({ reason: "out-of-scope" });
      expect(await f.requeue("http://example.com/a", { depth: 5 })).toMatchObject({
        reason: "too-deep",
      });
    });

    it("counts separately from first-time discoveries", async () => {
      const f = frontier();
      await f.addSeed("http://example.com/a");
      await f.requeue("http://example.com/a");

      expect(f.stats).toMatchObject({ enqueued: 1, requeued: 1 });
    });
  });

  describe("stats", () => {
    it("counts every rejection reason", async () => {
      const f = frontier({ maxDepth: 1, maxQueueSize: 3 });

      await f.addSeed("http://example.com/a");
      await f.addSeed("http://example.com/a");
      await f.addSeed("http://other.com/b");
      await f.add("http://example.com/c", { depth: 9 });
      await f.addSeed("javascript:alert(1)");
      await f.addSeed("http://example.com/robots.txt");
      await f.addSeed("http://example.com/d");
      await f.addSeed("http://example.com/e");
      await f.addSeed("http://example.com/f");

      expect(f.stats).toEqual({
        enqueued: 3,
        requeued: 0,
        duplicate: 1,
        outOfScope: 1,
        tooDeep: 1,
        invalidUrl: 1,
        queueFull: 1,
        excluded: 1,
      });
    });

    it("clear() empties the queue, the seen-set and the counters", async () => {
      const f = frontier();
      await f.addSeed("http://example.com/a");
      await f.addSeed("http://example.com/a");

      await f.clear();

      expect(await f.size()).toBe(0);
      expect(await f.seenCount()).toBe(0);
      expect(f.stats).toMatchObject({ enqueued: 0, duplicate: 0 });
      expectAdded(await f.addSeed("http://example.com/a"));
    });

    it("exposes a copy, so a caller cannot mutate the counters", async () => {
      const f = frontier();
      await f.addSeed("http://example.com/a");

      const snapshot = f.stats;
      await f.addSeed("http://example.com/b");

      expect(snapshot.enqueued).toBe(1);
      expect(f.stats.enqueued).toBe(2);
    });
  });

  it("resolves relative hrefs against a base", async () => {
    const f = frontier();
    const result = await f.add("../about", {
      depth: 1,
      base: "http://example.com/docs/guide/x",
    });

    expectAdded(result);
    expect(result.url).toBe("http://example.com/docs/about");
  });

  it("defaults to three hops past the seeds", () => {
    expect(FRONTIER_DEFAULTS.maxDepth).toBe(3);
  });
});

function describeStore(label: string, createStore: () => FrontierStore): void {
  describe(`${label} store`, () => {
    let store: FrontierStore;

    beforeEach(async () => {
      store = createStore();
      await store.clear();
    });

    it("markSeen reports first-writer-wins", async () => {
      expect(await store.markSeen("http://example.com/a")).toBe(true);
      expect(await store.markSeen("http://example.com/a")).toBe(false);
      expect(await store.hasSeen("http://example.com/a")).toBe(true);
      expect(await store.hasSeen("http://example.com/b")).toBe(false);
      expect(await store.seenCount()).toBe(1);
    });

    it("pops lowest depth first, insertion order within a depth", async () => {
      await store.enqueue("http://example.com/a", 1);
      await store.enqueue("http://example.com/b", 1);
      await store.enqueue("http://example.com/root", 0);

      expect(await store.pop(10)).toEqual([
        { url: "http://example.com/root", depth: 0 },
        { url: "http://example.com/a", depth: 1 },
        { url: "http://example.com/b", depth: 1 },
      ]);
    });

    it("pop takes at most `count`, and returns empty when drained", async () => {
      await store.enqueue("http://example.com/a", 0);
      await store.enqueue("http://example.com/b", 1);

      expect(await store.pop(1)).toEqual([{ url: "http://example.com/a", depth: 0 }]);
      expect(await store.size()).toBe(1);
      expect(await store.pop(0)).toEqual([]);
      expect(await store.pop(5)).toHaveLength(1);
      expect(await store.pop(5)).toEqual([]);
    });

    it("re-enqueuing a queued URL neither duplicates it nor moves it", async () => {
      await store.enqueue("http://example.com/a", 1);
      await store.enqueue("http://example.com/a", 5);

      expect(await store.size()).toBe(1);
      expect(await store.pop(10)).toEqual([{ url: "http://example.com/a", depth: 1 }]);
    });

    it("a popped URL can be enqueued again", async () => {
      await store.enqueue("http://example.com/a", 0);
      await store.pop(1);
      await store.enqueue("http://example.com/a", 2);

      expect(await store.pop(1)).toEqual([{ url: "http://example.com/a", depth: 2 }]);
    });

    it("clear empties both structures", async () => {
      await store.enqueue("http://example.com/a", 0);
      await store.markSeen("http://example.com/a");

      await store.clear();

      expect(await store.size()).toBe(0);
      expect(await store.seenCount()).toBe(0);
    });
  });
}

describeStore("memory", () => new MemoryFrontierStore());

const testRedis = await connectTestRedis();

if (testRedis) {
  describeStore("redis", () => new RedisFrontierStore(testRedis, TEST_KEY_PREFIX));

  afterAll(async () => {
    await new RedisFrontierStore(testRedis, TEST_KEY_PREFIX).clear();
    await testRedis.quit();
  });
} else {
  describe.skip(`redis store (no Redis at ${REDIS_TEST_URL})`, () => {
    it("skipped", () => {});
  });
}

async function connectTestRedis(): Promise<Redis | null> {
  const client = new Redis(REDIS_TEST_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });

  client.on("error", () => {});

  try {
    await client.connect();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}
