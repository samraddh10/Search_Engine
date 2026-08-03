//node:http is Node's built-in module for running an HTTP server or making HTTP requests.
//createServer builds a server.
//IncomingMessage is the type (a TypeScript description of the shape of a value) representing an incoming request
//ServerResponse is the type for the response you send back
//Server is the type of the server object itself.
//node:net is Node's lower-level networking module.
//ddressInfo is just the type describing what server.address() returns (host, port, family).
//node:zlib handles compression.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPage } from "./fetcher.js";

const servers: Server[] = [];

//afterEach is a Vitest hook (a function that automatically runs at a certain point in the test lifecycle).
afterEach(async () => {
  await Promise.all(
  //servers.splice(0) removes all elements from the array and returns them, leaving servers empty again
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
        //server.closeAllConnections() forcibly kills any sockets (open network connections)
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

//Helper functions
async function startServer(
//handler is a function you write when calling startServer — 
// it decides what the fake server sends back
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {

  //createServer(handler) uses Node's built-in http module to actually create the server, 
  // wired up to run handler whenever a request comes in.
  const server = createServer(handler);
  servers.push(server);
//Port 0 is special: it tells the OS "pick any free port for me,
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  //server.address() then asks the OS which port it actually picked, and .port extracts just the number.
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

//Just a tiny helper to avoid retyping full HTML boilerplate in every test
//  — wraps whatever string you give it in a minimal valid HTML page.
function html(body: string): string {
  return `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
}

//describe groups related tests together under a label (purely organizational — it doesn't run any test logic itself).
describe("fetchPage — the happy path", () => {
  it("returns the decoded body, status, content type and byte count", async () => {
    const origin = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html("hello"));
    });

  //Test 1 — basic successful fetch:
    const result = await fetchPage(`${origin}/page`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/html");
    expect(result.body).toContain("hello");
    expect(result.bytes).toBe(Buffer.byteLength(html("hello")));
    expect(result.attempts).toBe(1);
    expect(result.url).toBe(`${origin}/page`);
  });

//Test 2 — User-Agent and Accept headers
  it("identifies itself with the crawler User-Agent and asks for HTML", async () => {
    let seen: IncomingMessage["headers"] | undefined;

    const origin = await startServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("ua"));
    });

    await fetchPage(origin);

    expect(seen?.["user-agent"]).toContain("SearchEngine2Bot");
    expect(seen?.accept).toContain("text/html");
  });

  //Test 3 — gzip decompression (this is where your gzip comment belongs)
  it("transparently decompresses a gzipped response", async () => {
    const payload = html("compressed content");

    const origin = await startServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      });
      res.end(gzipSync(Buffer.from(payload)));
    });

    const result = await fetchPage(origin);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toBe(payload);
  });
});

describe("fetchPage — redirects", () => {
  //Test 1 — following a multi-step redirect chain
  it("follows the chain and reports the final URL, not the requested one", async () => {
    const origin = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/middle" });
        res.end();
        return;
      }
      if (req.url === "/middle") {
        res.writeHead(301, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("arrived"));
    });

    const result = await fetchPage(`${origin}/start`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.requestedUrl).toBe(`${origin}/start`);
    expect(result.url).toBe(`${origin}/final`);
    expect(result.body).toContain("arrived");
  });

  it("gives up on a redirect loop without retrying it", async () => {
    //Test 2 — redirect loop
    const origin = await startServer((_req, res) => {
      res.writeHead(302, { location: "/loop" });
      res.end();
    });

    const result = await fetchPage(`${origin}/loop`, { maxRedirects: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("too-many-redirects");
    expect(result.retryable).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("rejects a redirect to a non-http scheme", async () => {
    //Test 3 — redirect to a non-HTTP scheme
    const origin = await startServer((_req, res) => {
      res.writeHead(302, { location: "ftp://example.com/file" });
      res.end();
    });

    const result = await fetchPage(origin);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-url");
    expect(result.retryable).toBe(false);
  });

  it("treats a redirect with no Location header as a dead end", async () => {
    //Test 4 — redirect with no destination
    const origin = await startServer((_req, res) => {
      res.writeHead(302);
      res.end();
    });

    const result = await fetchPage(origin);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("http-error");
    expect(result.retryable).toBe(false);
  });
});

//"Guards" are safety checks meant to prevent the crawler from wasting resources or ending up with data it can't use.
describe("fetchPage — guards", () => {
  //Test 1 — skip non-HTML content
  it("skips non-HTML content", async () => {
    const origin = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(Buffer.alloc(1024));
    });

    const result = await fetchPage(`${origin}/doc.pdf`);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("unsupported-content-type");
    expect(result.retryable).toBe(false);
  });

  //Test 2 — missing Content-Type
  //No content-type header at all: Node doesn't add one unless asked, so this is the genuine
  //absent-header case rather than an empty-string stand-in.
  it("treats a missing Content-Type as unsupported rather than guessing HTML", async () => {
    const origin = await startServer((_req, res) => {
      res.writeHead(200);
      res.end("plain");
    });

    const result = await fetchPage(origin);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported-content-type");
  });

  //Test 3 — oversized body, declared via Content-Length
  it("refuses an oversized body declared by Content-Length", async () => {
    const payload = html("x".repeat(4000));

    const origin = await startServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    });

    const result = await fetchPage(origin, { maxBytes: 1000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
    expect(result.message).toContain("Content-Length");
  });

//Test 4 — oversized body, no declared length
  it("refuses an oversized body that never declares its length", async () => {
    const origin = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      for (let i = 0; i < 20; i += 1) res.write("y".repeat(500));
      res.end();
    });

    const result = await fetchPage(origin, { maxBytes: 1000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too-large");
    expect(result.retryable).toBe(false);
  });

  //Test 5 — rejecting bad URLs before any request is made
  it("rejects URLs that are not absolute http(s) before making a request", async () => {
    for (const bad of ["not a url", "/relative/path", "ftp://example.com", "file:///etc/passwd"]) {
      const result = await fetchPage(bad);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.reason).toBe("invalid-url");
      expect(result.retryable).toBe(false);
      expect(result.attempts).toBe(0);
    }
  });
});

//This tests the automatic retry logic — when should fetchPage try again on its own, and when should it give up?
describe("fetchPage — retries", () => {
  //Test 1 — a 404 is never retried
  it("does not retry a 404, and marks it undroppable-but-dead", async () => {
    let hits = 0;

    const origin = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(404, { "content-type": "text/html" });
      res.end(html("missing"));
    });

    const result = await fetchPage(origin, { baseBackoffMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("http-error");
    expect(result.status).toBe(404);
    expect(result.retryable).toBe(false);
    expect(result.attempts).toBe(1);
    expect(hits).toBe(1);
  });
//Test 2 — a 5xx error is retried up to the limit
//500 ("Internal Server Error") is a 5xx status
  it("retries a 5xx up to maxAttempts and then reports it as retryable", async () => {
    let hits = 0;

    const origin = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(500, { "content-type": "text/html" });
      res.end(html("boom"));
    });

    const result = await fetchPage(origin, { maxAttempts: 3, baseBackoffMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.status).toBe(500);
    expect(result.attempts).toBe(3);
    expect(hits).toBe(3);
    expect(result.retryable).toBe(true);
  });

  //Test 3 — recovery after one transient failure
  //503 means "Service Unavailable"
  it("recovers when a transient 503 is followed by a good response", async () => {
    let hits = 0;

    const origin = await startServer((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(503, { "content-type": "text/html" });
        res.end(html("try again"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("recovered"));
    });

    const result = await fetchPage(origin, { baseBackoffMs: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.attempts).toBe(2);
    expect(result.body).toContain("recovered");
  });

  //Test 4 — respecting a short Retry-After
  it("honours a short Retry-After on a 429", async () => {
    let hits = 0;

    const origin = await startServer((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(429, { "retry-after": "0", "content-type": "text/html" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("allowed"));
    });

    const result = await fetchPage(origin, { baseBackoffMs: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(2);
  });

  //Test 5 — refusing to wait for an unreasonably long Retry-After
  it("stops immediately when Retry-After asks for longer than we are willing to wait", async () => {
    let hits = 0;

    const origin = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(429, { "retry-after": "3600", "content-type": "text/html" });
      res.end();
    });

    const result = await fetchPage(origin, { maxAttempts: 3, baseBackoffMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(hits).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.retryable).toBe(true);
    //The wait the server asked for is handed back rather than swallowed. Without this the
    //scheduler would see retryable: true and immediately re-hit a host that asked for an
    //hour — politeness locally, rudeness globally.
    expect(result.retryAfterMs).toBe(3_600_000);
  });

  //Test 6 — Retry-After given as an HTTP date instead of a number of seconds
  it("accepts Retry-After as an HTTP date", async () => {
    let hits = 0;

    const origin = await startServer((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(429, {
          //HTTP dates have one-second granularity, so this resolves to a delay somewhere
          //between 0 and 1000ms — short enough to wait for, and it exercises the
          //Date.parse branch rather than the numeric one.
          "retry-after": new Date(Date.now() + 1000).toUTCString(),
          "content-type": "text/html",
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html("after the date"));
    });

    const result = await fetchPage(origin, { baseBackoffMs: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempts).toBe(2);
  });

  //Test 7 — 501 is the one 5xx we don't retry
  it("does not retry a 501, unlike other 5xx statuses", async () => {
    let hits = 0;

    const origin = await startServer((_req, res) => {
      hits += 1;
      res.writeHead(501, { "content-type": "text/html" });
      res.end();
    });

    const result = await fetchPage(origin, { maxAttempts: 3, baseBackoffMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    //An unimplemented method will still be unimplemented on the next attempt.
    expect(hits).toBe(1);
    expect(result.retryable).toBe(false);
  });

  //Test 8 — nothing listening on the port at all
  it("classifies a refused connection as a retryable network failure", async () => {
    //Start a server purely to be handed a port the OS considers free, then shut it down so
    //nothing is listening there. Connection-refused is the most common real-world crawl
    //failure, and the branch deciding it's worth retrying otherwise had no test.
    const origin = await startServer((_req, res) => res.end());
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const result = await fetchPage(origin, { maxAttempts: 1, baseBackoffMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("network");
    expect(result.retryable).toBe(true);
  });
});

//Tests around stopping a request that's taking too long, or that the caller wants to abandon.
describe("fetchPage — cancellation", () => {
//Test 1 — a server that never responds at all (timeout)
  it("times out a server that never responds, and calls it retryable", async () => {
    const origin = await startServer(() => {});

    const result = await fetchPage(origin, { timeoutMs: 100, maxAttempts: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  //Test 2 — a response that starts, then stalls partway through
  it("times out a body that stalls mid-stream", async () => {
    const origin = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><body>partial");
    });

    const result = await fetchPage(origin, { timeoutMs: 100, maxAttempts: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("timeout");
  });

  //Test 3 — caller-triggered abort vs. a timeout
  it("reports a caller's abort as non-retryable, unlike a timeout", async () => {
    const origin = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html("too late"));
      }, 2000).unref();
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50).unref();

    const result = await fetchPage(origin, {
      signal: controller.signal,
      timeoutMs: 5000,
      maxAttempts: 3,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("aborted");
    expect(result.retryable).toBe(false);
    expect(result.attempts).toBe(1);
  });

  //Test 4 — abort landing in the gap between attempts, not during a request
  it("abandons a pending backoff instead of waiting it out", async () => {
    const origin = await startServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/html" });
      res.end();
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50).unref();

    //A 5s base backoff means the first retry is scheduled 2.5–5s out. If the sleep ignored
    //the signal, this call could only return after sitting through that.
    const result = await fetchPage(origin, {
      signal: controller.signal,
      baseBackoffMs: 5000,
      maxAttempts: 3,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toBe("aborted");
    expect(result.retryable).toBe(false);
    expect(result.elapsedMs).toBeLessThan(1000);
  });
});

//Charset handling arrived with 1.3 (see crawler/charset.ts for why it lives there rather
//than in the parser). charset.test.ts covers the decision table against raw byte arrays;
//these two cover the wiring — that the header actually reaches the decoder and that the
//decoded string comes back over a real socket, not just out of a unit test's Uint8Array.
describe("fetchPage — charset", () => {
  it("decodes a legacy encoding declared in the Content-Type header", async () => {
    //0xE9 is "é" in windows-1252 and an invalid lone continuation byte in UTF-8, so a
    //decode that ignored the header would produce U+FFFD here instead.
    const body = Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x74, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]);

    const origin = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
      res.end(body);
    });

    const result = await fetchPage(`${origin}/legacy`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.body).toBe("<p>été</p>");
    //Canonical spelling, not the label the server sent: iso-8859-1 *is* windows-1252.
    expect(result.charset).toBe("windows-1252");
    //`bytes` measures the undecoded response, so it stays 10 even though the decoded
    //string is shorter in characters than it was in bytes.
    expect(result.bytes).toBe(body.byteLength);
    expect(result.contentType).toBe("text/html");
  });

  it("falls back to a <meta charset> when the header is silent", async () => {
    const body = Buffer.concat([
      Buffer.from('<html><head><meta charset="windows-1252"></head><body><p>', "latin1"),
      Buffer.from([0xe9]),
      Buffer.from("</p></body></html>", "latin1"),
    ]);

    const origin = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    });

    const result = await fetchPage(`${origin}/meta`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.charset).toBe("windows-1252");
    expect(result.body).toContain("<p>é</p>");
  });
});
