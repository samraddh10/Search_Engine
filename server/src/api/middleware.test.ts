import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { asyncRoute, errorHandler } from "./middleware.js";

// No database and no `app` — these two are the boundary rules themselves, and mounting them on a
// throwaway Express instance is the only way to make a handler fail on purpose.
function appWith(handler: () => Promise<unknown>): express.Express {
  const testApp = express();
  testApp.get(
    "/boom",
    asyncRoute(async () => {
      await handler();
    }),
  );
  testApp.use(errorHandler);
  return testApp;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("asyncRoute", () => {
  it("answers a rejected handler instead of hanging", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const testApp = appWith(() => Promise.reject(new Error("boom")));

    // This is the Express 4 hazard the wrapper exists for: without it the rejection is unhandled,
    // no response is ever written, and the request hangs until the client gives up — a failure
    // mode that never shows up in a suite asserting only happy paths.
    const res = await request(testApp).get("/boom");

    expect(res.status).toBe(500);
    expect(logged).toHaveBeenCalled();
  });

  it("does not leak the underlying error to the caller", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const testApp = appWith(() =>
      Promise.reject(new Error('relation "documents" does not exist')),
    );

    const res = await request(testApp).get("/boom");

    // A Postgres error message on the wire names our columns to an anonymous caller.
    expect(res.body).toEqual({ error: "Internal error" });
    expect(res.text).not.toContain("documents");
  });
});

describe("errorHandler", () => {
  it("answers a zod failure as 400 with one flat message", async () => {
    const testApp = appWith(async () => z.object({ q: z.string() }).parse({}));

    const res = await request(testApp).get("/boom");

    expect(res.status).toBe(400);
    // One string, not zod's issue tree — the tree describes our schema to a stranger.
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error).toContain("q");
  });
});
