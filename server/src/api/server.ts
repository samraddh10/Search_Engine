import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
//Its main job is to set HTTP security headers on your server's responses.
import helmet from "helmet";
import { pgPool } from "../db/pg.js";
import { SuggestIndex } from "../search/autocomplete.js";
import { ResultCache } from "../search/cache.js";
import { CorpusVersion } from "../search/corpusVersion.js";
import { errorHandler } from "./middleware.js";
import { createRouter } from "./routes.js";

/**
 * The composition root.
 *
 * One `CorpusVersion` for the process, shared by both consumers that go stale. Two watchers
 * would double the poll and let the cache and the suggest index disagree about which corpus they
 * describe — which is the whole reason 3.4 extracted the watcher instead of letting the cache
 * grow its own.
 */
export const corpusVersion = new CorpusVersion(pgPool);
export const suggestIndex = new SuggestIndex(pgPool, { version: corpusVersion });
export const resultCache = new ResultCache();

const app = express();

//Behind the host's proxy every request otherwise carries the proxy's address, which puts every
//user in one rate-limit bucket — the limiter then either does nothing or blocks all of them at
//once. `1` rather than `true`: trust exactly the one hop we deploy behind.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors());
//No `express.json()`. Every endpoint is a GET, so it would parse nothing and only widen what
//the API accepts.

app.use("/api", createRouter({ db: pgPool, version: corpusVersion, cache: resultCache, suggest: suggestIndex }));

//An unmatched /api path has to answer here, and it has to answer JSON. A Router does not
//terminate paths it did not match, so without this `/api/typo` falls through to the SPA fallback
//below and returns index.html with a 200 — HTML where the client's fetch expects JSON, which is
//the one failure `client/services/api.ts` can only report as UNPARSEABLE.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

//Phase 6.2: one instance serves both the API and the built client, which is what keeps the
//client's `/api` default base URL correct and means there is no cross-origin story to configure.
//
//Resolved from this module's own URL rather than `process.cwd()`, which is whatever directory
//the process was started from. The `../../..` is the same in both layouts — `server/src/api`
//under tsx and `server/dist/api` after a build — so one path serves dev and production.
const clientDist = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../client/dist");
const clientIndex = path.join(clientDist, "index.html");

//Mounted only when the bundle is actually there. `npm run dev:server` is used with Vite serving
//the client, and the test suite runs against a checkout that may never have built it; in both
//cases a fallback pointing at a missing index.html would turn every unknown path into a 500.
if (existsSync(clientIndex)) {
  app.use(express.static(clientDist));

  //react-router owns the URL space, so anything that is not an API path and not a file on disk is
  //a client route and gets the shell. Registered after express.static, or the shell would shadow
  //every asset.
  app.get("*", (_req, res) => {
    res.sendFile(clientIndex);
  });
}

//Last, and after the routes: Express picks an error handler by arity, and one registered before
//the routes it guards never sees their failures.
app.use(errorHandler);

export default app;
