import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { closePg } from "../db/pg.js";
import app from "./server.js";

// This suite is the payoff for splitting api/server.ts (builds `app`) from index.ts
// (calls `listen`): supertest drives the real Express app without binding a port.
afterAll(closePg);

// Test 1 — Basic health check response
describe("GET /api/health", () => {
  it("returns 200 when Postgres is up and Redis is absent", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      dependencies: { postgres: true, redis: "not_configured" },
    });
  });

  // `defaultPageSize` and its assertion lived here from 0.2 as a proof that the shared/
  // workspace resolves across the ESM boundary. It never belonged on a health check, and the
  // real endpoints now exercise that import far better: /search reads MAX_PAGE_SIZE and
  // DEFAULT_PAGE_SIZE out of shared/ on every request.
  it("does not echo internal configuration", async () => {
    const res = await request(app).get("/api/health");

    expect(res.body.defaultPageSize).toBeUndefined();
  });

  // Test 3 — Content-type check
  it("responds as JSON", async () => {
    const res = await request(app).get("/api/health");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
