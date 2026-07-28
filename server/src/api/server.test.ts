import { DEFAULT_PAGE_SIZE } from "shared";
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

  // Guards the cross-workspace contract: this value crosses the shared/ ESM boundary, so
  // the test fails if that resolution ever breaks.
  // Test 2 — Cross-workspace import sanity check
  it("serves DEFAULT_PAGE_SIZE from the shared workspace", async () => {
    const res = await request(app).get("/api/health");

    expect(res.body.defaultPageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  // Test 3 — Content-type check
  it("responds as JSON", async () => {
    const res = await request(app).get("/api/health");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
