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

//Last, and after the routes: Express picks an error handler by arity, and one registered before
//the routes it guards never sees their failures.
app.use(errorHandler);

export default app;
