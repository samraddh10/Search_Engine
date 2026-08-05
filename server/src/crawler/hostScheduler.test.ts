import { describe, expect, it } from "vitest";
import { HostScheduler } from "./hostScheduler.js";

//A fake clock, so the politeness policy is tested by arithmetic rather than by sleeping.
function scheduler(): { hosts: HostScheduler; advance: (ms: number) => void } {
  let clock = 1_000;
  const hosts = new HostScheduler({ now: () => clock });

  return { hosts, advance: (ms) => void (clock += ms) };
}

function url(entry: { url: string }): string {
  return entry.url;
}

describe("HostScheduler", () => {
  it("reports empty until something is buffered", () => {
    const { hosts } = scheduler();

    expect(hosts.next()).toEqual({ type: "empty" });
    expect(hosts.buffered).toBe(0);
  });

  it("dispatches a buffered URL and marks its host in flight", () => {
    const { hosts } = scheduler();
    hosts.add([{ url: "http://a.com/1", depth: 0 }]);

    expect(hosts.next()).toEqual({ type: "ready", entry: { url: "http://a.com/1", depth: 0 } });
    expect(hosts.buffered).toBe(0);
    expect(hosts.inFlightHosts).toBe(1);
  });

  it("holds a host to one request at a time, regardless of delay", () => {
    const { hosts } = scheduler();
    hosts.add([
      { url: "http://a.com/1", depth: 0 },
      { url: "http://a.com/2", depth: 0 },
    ]);

    expect(hosts.next()).toMatchObject({ type: "ready" });
    //Second URL for the same host: no timer can help, only a release.
    expect(hosts.next()).toEqual({ type: "blocked" });

    hosts.release("http://a.com/1", 0);
    expect(hosts.next()).toMatchObject({ type: "ready", entry: { url: "http://a.com/2" } });
  });

  it("rotates across hosts instead of draining one first", () => {
    const { hosts } = scheduler();
    hosts.add([
      { url: "http://a.com/1", depth: 0 },
      { url: "http://a.com/2", depth: 0 },
      { url: "http://a.com/3", depth: 0 },
      { url: "http://b.com/1", depth: 0 },
      { url: "http://c.com/1", depth: 0 },
    ]);

    const dispatched: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = hosts.next();
      if (next.type !== "ready") throw new Error(`expected ready, got ${next.type}`);
      dispatched.push(url(next.entry));
    }

    //One from each host before a second from any — this is the property that stops a batch
    //dominated by one host from idling the pool.
    expect(dispatched).toEqual(["http://a.com/1", "http://b.com/1", "http://c.com/1"]);
  });

  it("counts the cooldown from release, and reports how long is left", () => {
    const { hosts, advance } = scheduler();
    hosts.add([
      { url: "http://a.com/1", depth: 0 },
      { url: "http://a.com/2", depth: 0 },
    ]);

    hosts.next();
    advance(300); //the request itself took 300ms — the delay starts after it, not before
    hosts.release("http://a.com/1", 1_000);

    expect(hosts.next()).toEqual({ type: "wait", waitMs: 1_000 });

    advance(400);
    expect(hosts.next()).toEqual({ type: "wait", waitMs: 600 });

    advance(600);
    expect(hosts.next()).toMatchObject({ type: "ready", entry: { url: "http://a.com/2" } });
  });

  it("reports the soonest ready time across several cooling hosts", () => {
    const { hosts } = scheduler();
    hosts.add([
      { url: "http://a.com/1", depth: 0 },
      { url: "http://b.com/1", depth: 0 },
    ]);

    hosts.next();
    hosts.next();
    hosts.release("http://a.com/1", 5_000);
    hosts.release("http://b.com/1", 800);

    hosts.add([
      { url: "http://a.com/2", depth: 0 },
      { url: "http://b.com/2", depth: 0 },
    ]);

    expect(hosts.next()).toEqual({ type: "wait", waitMs: 800 });
  });

  it("prefers a dispatchable host over reporting a wait", () => {
    const { hosts } = scheduler();
    hosts.add([{ url: "http://a.com/1", depth: 0 }]);
    hosts.next();
    hosts.release("http://a.com/1", 10_000);

    hosts.add([
      { url: "http://a.com/2", depth: 0 },
      { url: "http://b.com/1", depth: 0 },
    ]);

    expect(hosts.next()).toMatchObject({ type: "ready", entry: { url: "http://b.com/1" } });
  });

  it("prefers a wait over blocked, since a timer is actionable and a completion is not", () => {
    const { hosts } = scheduler();
    hosts.add([
      { url: "http://a.com/1", depth: 0 },
      { url: "http://a.com/2", depth: 0 },
      { url: "http://b.com/1", depth: 0 },
      { url: "http://b.com/2", depth: 0 },
    ]);

    hosts.next(); //a.com/1 → a in flight
    hosts.next(); //b.com/1 → b in flight
    hosts.release("http://b.com/1", 700); //b now cooling; a still in flight

    expect(hosts.next()).toEqual({ type: "wait", waitMs: 700 });
  });

  it("treats www, apex and both schemes as one host, but not other subdomains", () => {
    const { hosts } = scheduler();
    hosts.add([
      { url: "http://example.com/1", depth: 0 },
      { url: "https://www.example.com/2", depth: 0 },
      { url: "http://docs.example.com/3", depth: 0 },
    ]);

    expect(hosts.next()).toMatchObject({ entry: { url: "http://example.com/1" } });
    //docs. is a different site's worth of content, so it dispatches in parallel...
    expect(hosts.next()).toMatchObject({ entry: { url: "http://docs.example.com/3" } });
    //...while www + https is the same machine, and must wait its turn.
    expect(hosts.next()).toEqual({ type: "blocked" });

    hosts.release("https://www.example.com/2", 0);
    expect(hosts.next()).toMatchObject({ entry: { url: "https://www.example.com/2" } });
  });

  it("drops entries that are not usable http(s) URLs rather than bucketing them", () => {
    const { hosts } = scheduler();
    hosts.add([
      { url: "javascript:alert(1)", depth: 0 },
      { url: "not a url", depth: 0 },
      { url: "http://a.com/1", depth: 0 },
    ]);

    expect(hosts.buffered).toBe(1);
    expect(hosts.next()).toMatchObject({ entry: { url: "http://a.com/1" } });
  });

  it("release ignores a URL it never dispatched", () => {
    const { hosts } = scheduler();

    expect(() => hosts.release("not a url", 100)).not.toThrow();
    expect(hosts.inFlightHosts).toBe(0);
  });

  it("drain hands back everything buffered and empties itself", () => {
    const { hosts } = scheduler();
    hosts.add([
      { url: "http://a.com/1", depth: 0 },
      { url: "http://a.com/2", depth: 1 },
      { url: "http://b.com/1", depth: 2 },
    ]);
    hosts.next(); //a.com/1 is now in flight, so it is no longer buffered

    const drained = hosts.drain();

    expect(drained).toHaveLength(2);
    expect(drained).toContainEqual({ url: "http://a.com/2", depth: 1 });
    expect(drained).toContainEqual({ url: "http://b.com/1", depth: 2 });
    expect(hosts.buffered).toBe(0);
    expect(hosts.next()).toEqual({ type: "empty" });
  });

  it("keeps a host's cooldown across its queue emptying and refilling", () => {
    const { hosts, advance } = scheduler();
    hosts.add([{ url: "http://a.com/1", depth: 0 }]);
    hosts.next();
    hosts.release("http://a.com/1", 1_000);

    expect(hosts.next()).toEqual({ type: "empty" });

    advance(200);
    hosts.add([{ url: "http://a.com/2", depth: 0 }]);

    expect(hosts.next()).toEqual({ type: "wait", waitMs: 800 });
  });

  it("stays correct after compacting away many drained hosts", () => {
    const { hosts } = scheduler();

    for (let i = 0; i < 40; i++) {
      hosts.add([{ url: `http://host${i}.com/1`, depth: 0 }]);
    }
    for (let i = 0; i < 40; i++) {
      const next = hosts.next();
      if (next.type !== "ready") throw new Error(`expected ready, got ${next.type}`);
      hosts.release(next.entry.url, 0);
    }

    expect(hosts.buffered).toBe(0);

    hosts.add([
      { url: "http://late.com/1", depth: 0 },
      { url: "http://host7.com/2", depth: 0 },
    ]);

    const first = hosts.next();
    const second = hosts.next();

    expect([first, second].map((d) => (d.type === "ready" ? d.entry.url : d.type)).sort()).toEqual(
      ["http://host7.com/2", "http://late.com/1"],
    );
  });
});
