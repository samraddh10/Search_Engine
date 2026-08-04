import type { Redis } from "ioredis";

export interface QueuedUrl {
  readonly url: string;
  readonly depth: number;
}

export interface FrontierStore {
  markSeen(url: string): Promise<boolean>;
  hasSeen(url: string): Promise<boolean>;
  enqueue(url: string, depth: number): Promise<void>;
  pop(count: number): Promise<QueuedUrl[]>;
  size(): Promise<number>;
  seenCount(): Promise<number>;
  clear(): Promise<void>;
}

export const FRONTIER_KEY_PREFIX = "frontier:";

//— the simple, in-process version
//implements FrontierStore is TypeScript's way of saying "this class promises to satisfy that interface."
export class MemoryFrontierStore implements FrontierStore {
  //#seen — every URL ever marked seen, forever, for the life of this store. This is what dedup checks against.
  readonly #seen = new Set<string>();
  //#queue — the actual array of QueuedUrl objects, waiting to be fetched.
  readonly #queue: QueuedUrl[] = [];
  //#queued — a separate set, tracking only which URLs are currently sitting in the queue right now.
  readonly #queued = new Set<string>();

  //Check if the URL is already in the seen set. If yes, return false (nothing changed, not new). If no, add it and return true.
  async markSeen(url: string): Promise<boolean> {
    if (this.#seen.has(url)) return false;

    this.#seen.add(url);
    return true;
  }

  //Just a membership check, read-only, no side effects.
  async hasSeen(url: string): Promise<boolean> {
    return this.#seen.has(url);
  }

  //Purpose: insert a new URL into the queue, keeping the whole array sorted by depth, ascending 
  // — so the shallowest (closest-to-seed) URLs always come out first.
  //This gives the crawl breadth-first behavior: finish all of depth 0 before moving to depth 1, and so on.
  async enqueue(url: string, depth: number): Promise<void> {
    if (this.#queued.has(url)) return;
    //this.#queued.add(url) — record that it's now in the queue.
    this.#queued.add(url);

    let at = this.#queue.length;
    while (at > 0 && this.#queue[at - 1]!.depth > depth) at--;

    this.#queue.splice(at, 0, { url, depth });
  }

  //Removes up to count items from the front of the array (which, since it's sorted, means the lowest-depth ones) and returns them.
  async pop(count: number): Promise<QueuedUrl[]> {
    if (count <= 0) return [];

    const popped = this.#queue.splice(0, count);
    for (const entry of popped) this.#queued.delete(entry.url);

    return popped;
  }

  async size(): Promise<number> {
    return this.#queue.length;
  }

  async seenCount(): Promise<number> {
    return this.#seen.size;
  }

  async clear(): Promise<void> {
    this.#seen.clear();
    this.#queue.length = 0;
    this.#queued.clear();
  }
}

export class RedisFrontierStore implements FrontierStore {
  readonly #client: Redis;
  readonly #queueKey: string;
  readonly #seenKey: string;

  constructor(client: Redis, keyPrefix: string = FRONTIER_KEY_PREFIX) {
    this.#client = client;
    this.#queueKey = `${keyPrefix}queue`;
    this.#seenKey = `${keyPrefix}seen`;
  }

  //SADD is a real Redis command: "add a member to a Set.
  async markSeen(url: string): Promise<boolean> {
    return (await this.#client.sadd(this.#seenKey, url)) === 1;
  }

  //SISMEMBER = "is this member in the Set?" — Redis replies 1 or 0, converted to a proper boolean.
  async hasSeen(url: string): Promise<boolean> {
    return (await this.#client.sismember(this.#seenKey, url)) === 1;
  }

  //ZADD adds a member to a sorted set — a Redis data structure where every member has a numeric score,
  //  and Redis automatically keeps everything ordered by that score, at all times, for free.
  async enqueue(url: string, depth: number): Promise<void> {
    await this.#client.zadd(this.#queueKey, "NX", depth, url);
  }

  //ZPOPMIN removes and returns the members with the lowest scores from a sorted set — exactly "give me the lowest-depth URLs" 
  // — matching the breadth-first order the memory version had to build by hand
  async pop(count: number): Promise<QueuedUrl[]> {
    if (count <= 0) return [];

    const flat = await this.#client.zpopmin(this.#queueKey, count);

    //Number(flat[at + 1]!) is needed because Redis always returns scores as strings, even though they're conceptually numbers 
    // — so this converts it back to a real JavaScript number.
    const popped: QueuedUrl[] = [];
    for (let at = 0; at + 1 < flat.length; at += 2) {
      popped.push({ url: flat[at]!, depth: Number(flat[at + 1]!) });
    }

    return popped;
  }

  async size(): Promise<number> {
    return this.#client.zcard(this.#queueKey);
  }

  async seenCount(): Promise<number> {
    return this.#client.scard(this.#seenKey);
  }

  async clear(): Promise<void> {
    await this.#client.del(this.#queueKey, this.#seenKey);
  }
}
