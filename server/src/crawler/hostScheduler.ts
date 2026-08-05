import type { QueuedUrl } from "./frontierStore.js";
import { canonicalHost, parseHttpUrl } from "./url.js";

//COMPACT_FLOOR = 16 is the trigger threshold: "don't bother cleaning up the list until it's grown to at least 16 entries." Below that, cleanup isn't worth the extra work.
const COMPACT_FLOOR = 16;

export type Dispatch =
  | { type: "ready"; entry: QueuedUrl }
  | { type: "wait"; waitMs: number }
  | { type: "blocked" }
  | { type: "empty" };

export interface HostSchedulerOptions {
  now?: () => number;
}

export class HostScheduler {
  readonly #queues = new Map<string, QueuedUrl[]>();
  //#queues: Map from host → array of URLs waiting for that host. E.g. {"example.com": [url1, url2], "other.com": [url3]}.
  //#order: a plain array of host names, representing the rotation order
  #order: string[] = [];
  //#cursor: a number — an index into #order marking where the next scan should start. Its purpose (explained further down) 
  // is to make consecutive calls to next() move around the rotation rather than restarting from host #0 every time (which would let the first host in the list hog attention).
  #cursor = 0;
  //#inFlight: a Set of hostnames currently being fetched.
  readonly #inFlight = new Set<string>();
  //#readyAt: Map from host → the timestamp (in milliseconds) at which that host becomes fetchable again.
  readonly #readyAt = new Map<string, number>();
  //#buffered: a running count of total URLs currently sitting in all the per-host queues combined.
  #buffered = 0;
  //#nonEmpty: a running count of how many hosts currently have a non-empty queue. Used only to decide when cleanup (#compactIfSparse) is worth doing.
  #nonEmpty = 0;
  //#now: the clock function actually used internally — either the injected fake clock or the real Date.now.
  readonly #now: () => number;

  constructor(options: HostSchedulerOptions = {}) {
    //the ?? is the nullish coalescing operator: "use the left side, unless it's null or undefined,
    //in which case use the right side." So: use the custom clock if one was given, otherwise fall back to the real Date.now function.
    this.#now = options.now ?? Date.now;
  }

  //add() — putting freshly-popped URLs into the scheduler
  //void means this method doesn't return anything useful.
  add(entries: Iterable<QueuedUrl>): void {
    for (const entry of entries) {
      const url = parseHttpUrl(entry.url);
      if (!url) continue;

      //Get the normalized host name from the URL, then look up whether we already have a queue (array) for that host in #queues.
      const host = canonicalHost(url.hostname);
      let queue = this.#queues.get(host);


      //If there's no existing queue for this host (first time we've seen it), create a new empty array, store it in the Map under that host's key, 
      // and add the host name to the rotation list (#order) so it'll be considered during dispatch.
      if (!queue) {
        queue = [];
        this.#queues.set(host, queue);
        this.#order.push(host);
      }
      if (queue.length === 0) this.#nonEmpty++;

      queue.push(entry);
      this.#buffered++;
    }
  }

  //next() — the heart of the class: "what should I fetch next?"
  next(): Dispatch {
    if (this.#buffered === 0) return { type: "empty" };

    this.#compactIfSparse();

    //Get the current time once (so all comparisons in this call use the same "now," rather than the clock possibly ticking mid-scan)
    // . Set up two tracking variables:
    const now = this.#now();
    //soonest — the smallest wait-time we've found so far among cooling-down hosts. Start it at Infinity (a special number bigger than everything) 
    // as a placeholder meaning "no candidate found yet."
    let soonest = Infinity;
    //a flag ("did we encounter at least one host that has waiting work but is currently busy fetching?").
    let sawInFlight = false;

    //This is the round-robin scan.
    for (let step = 0; step < this.#order.length; step++) {
      const at = (this.#cursor + step) % this.#order.length;
      const host = this.#order[at]!;
      const queue = this.#queues.get(host);
      if (!queue || queue.length === 0) continue;

      if (this.#inFlight.has(host)) {
        sawInFlight = true;
        continue;
      }

      const readyAt = this.#readyAt.get(host) ?? 0;
      if (readyAt > now) {
        soonest = Math.min(soonest, readyAt - now);
        continue;
      }

      //If we get past all the checks above, this host has waiting work, isn't currently in-flight, and isn't cooling down — it's dispatchable!
      //queue.shift() — removes and returns the first item from the array
      const entry = queue.shift()!;
      if (queue.length === 0) this.#nonEmpty--;
      this.#buffered--;
      this.#inFlight.add(host);
      this.#cursor = at + 1;

      return { type: "ready", entry };
    }

    //If the loop finishes without returning (meaning: we scanned every host in the rotation and none of them were dispatchable):
    //If we found at least one host that's just cooling down (soonest got updated from Infinity to some real number),
    //  tell the caller "wait this many milliseconds."
    if (soonest !== Infinity) return { type: "wait", waitMs: soonest };
    //Otherwise, if we saw at least one host that's in-flight (busy, no timer helps), tell the caller "blocked."
    if (sawInFlight) return { type: "blocked" };

    return { type: "empty" };
  }

  //release() — "I'm done fetching this URL"
  release(url: string, notBeforeMs = 0): void {
    const parsed = parseHttpUrl(url);
    if (!parsed) return;

    const host = canonicalHost(parsed.hostname);
    this.#inFlight.delete(host);
    this.#readyAt.set(host, this.#now() + Math.max(0, notBeforeMs));
  }

  //drain() — emptying everything out (used on shutdown)
  drain(): QueuedUrl[] {
    const pending: QueuedUrl[] = [];

    for (const queue of this.#queues.values()) {
      pending.push(...queue.splice(0));
    }

    //Reset everything back to empty/initial state, and return the full list of everything that was still waiting.
    this.#queues.clear();
    this.#order = [];
    this.#cursor = 0;
    this.#buffered = 0;
    this.#nonEmpty = 0;

    return pending;
  }

  get buffered(): number {
    return this.#buffered;
  }

  get inFlightHosts(): number {
    return this.#inFlight.size;
  }

  //This is a private method (only callable from inside the class). It decides whether cleanup is worth doing right now, using two conditions
  #compactIfSparse(): void {
    if (this.#order.length < COMPACT_FLOOR || this.#order.length <= this.#nonEmpty * 2) return;

    for (const [host, queue] of this.#queues) {
      if (queue.length === 0) this.#queues.delete(host);
    }

    this.#order = [...this.#queues.keys()];
    this.#cursor = 0;
  }
}
