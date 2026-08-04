import type { FrontierStore, QueuedUrl } from "./frontierStore.js";
import { normalizeUrl, parseHttpUrl } from "./url.js";

export const FRONTIER_DEFAULTS = {
  maxDepth: 3,
  maxQueueSize: 100_000,
} as const;

export interface FrontierOptions {
  allowedHosts?: readonly string[];
  maxDepth?: number;
  maxQueueSize?: number;
}

export interface AddOptions {
  depth?: number;
  base?: string | URL;
}

export type AddRejection =
  | "invalid-url"
  | "too-deep"
  | "excluded"
  | "out-of-scope"
  | "queue-full"
  | "duplicate";

export interface AddAccepted {
  added: true;
  requestedUrl: string;
  url: string;
  depth: number;
}

export interface AddRejected {
  added: false;
  requestedUrl: string;
  url: string | null;
  reason: AddRejection;
}

export type AddResult = AddAccepted | AddRejected;

export interface FrontierStats {
  enqueued: number;
  requeued: number;
  duplicate: number;
  outOfScope: number;
  tooDeep: number;
  invalidUrl: number;
  queueFull: number;
  excluded: number;
}

export function hostsFromSeeds(seeds: readonly string[]): string[] {
  const hosts = new Set<string>();

  for (const seed of seeds) {
    const url = parseHttpUrl(seed);
    if (url) hosts.add(canonicalHost(url.hostname));
  }

  return [...hosts];
}

export class Frontier {
  readonly #store: FrontierStore;
  readonly #allowedHosts: ReadonlySet<string> | null;
  readonly #maxDepth: number;
  readonly #maxQueueSize: number;
  readonly #stats: FrontierStats = {
    enqueued: 0,
    requeued: 0,
    duplicate: 0,
    outOfScope: 0,
    tooDeep: 0,
    invalidUrl: 0,
    queueFull: 0,
    excluded: 0,
  };

  constructor(store: FrontierStore, options: FrontierOptions = {}) {
    this.#store = store;
    this.#allowedHosts = options.allowedHosts
      ? new Set(options.allowedHosts.map((host) => canonicalHost(host)))
      : null;
    this.#maxDepth = options.maxDepth ?? FRONTIER_DEFAULTS.maxDepth;
    this.#maxQueueSize = options.maxQueueSize ?? FRONTIER_DEFAULTS.maxQueueSize;
  }

  async addSeed(url: string): Promise<AddResult> {
    return this.add(url, { depth: 0 });
  }

  async add(requestedUrl: string, options: AddOptions = {}): Promise<AddResult> {
    return this.#insert(requestedUrl, options, false);
  }

  async requeue(requestedUrl: string, options: AddOptions = {}): Promise<AddResult> {
    return this.#insert(requestedUrl, options, true);
  }

  async markSeen(requestedUrl: string, base?: string | URL): Promise<boolean> {
    const url = normalizeUrl(requestedUrl, base);
    if (!url) return false;

    return this.#store.markSeen(url);
  }

  async hasSeen(requestedUrl: string, base?: string | URL): Promise<boolean> {
    const url = normalizeUrl(requestedUrl, base);
    if (!url) return false;

    return this.#store.hasSeen(url);
  }

  async next(): Promise<QueuedUrl | null> {
    const [first] = await this.#store.pop(1);
    return first ?? null;
  }

  async popBatch(count: number): Promise<QueuedUrl[]> {
    return this.#store.pop(count);
  }

  async size(): Promise<number> {
    return this.#store.size();
  }

  async seenCount(): Promise<number> {
    return this.#store.seenCount();
  }

  async clear(): Promise<void> {
    await this.#store.clear();
    for (const key of Object.keys(this.#stats) as (keyof FrontierStats)[]) {
      this.#stats[key] = 0;
    }
  }

  get stats(): Readonly<FrontierStats> {
    return { ...this.#stats };
  }

  async #insert(
    requestedUrl: string,
    options: AddOptions,
    isRequeue: boolean,
  ): Promise<AddResult> {
    const { depth = 0, base } = options;

    const parsed = parseHttpUrl(requestedUrl, base);
    if (!parsed) return this.#reject(requestedUrl, null, "invalid-url");

    if (depth > this.#maxDepth) return this.#reject(requestedUrl, parsed.href, "too-deep");

    if (parsed.pathname.toLowerCase() === "/robots.txt") {
      return this.#reject(requestedUrl, parsed.href, "excluded");
    }

    if (!this.#inScope(parsed.hostname)) {
      return this.#reject(requestedUrl, parsed.href, "out-of-scope");
    }

    const url = normalizeUrl(parsed.href);
    if (!url) return this.#reject(requestedUrl, null, "invalid-url");

    if ((await this.#store.size()) >= this.#maxQueueSize) {
      return this.#reject(requestedUrl, url, "queue-full");
    }

    if (isRequeue) {
      await this.#store.markSeen(url);
    } else if (!(await this.#store.markSeen(url))) {
      return this.#reject(requestedUrl, url, "duplicate");
    }

    await this.#store.enqueue(url, depth);
    this.#stats[isRequeue ? "requeued" : "enqueued"]++;

    return { added: true, requestedUrl, url, depth };
  }

  #inScope(hostname: string): boolean {
    if (!this.#allowedHosts) return true;

    return this.#allowedHosts.has(canonicalHost(hostname));
  }

  #reject(requestedUrl: string, url: string | null, reason: AddRejection): AddRejected {
    this.#stats[REJECTION_COUNTERS[reason]]++;
    return { added: false, requestedUrl, url, reason };
  }
}

const REJECTION_COUNTERS: Record<AddRejection, keyof FrontierStats> = {
  "invalid-url": "invalidUrl",
  "too-deep": "tooDeep",
  excluded: "excluded",
  "out-of-scope": "outOfScope",
  "queue-full": "queueFull",
  duplicate: "duplicate",
};

function canonicalHost(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
}
