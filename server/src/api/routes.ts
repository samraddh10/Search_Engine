//Express's tool for building a group of related routes as a self-contained unit,
import { Router } from "express";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_QUERY_LENGTH,
  type SearchResponse,
  type Statistics,
} from "shared";
import { z } from "zod";
import { checkPgHealth } from "../db/pg.js";
import { checkRedisHealth } from "../db/redis.js";
import { readCorpusSources, readCorpusStats } from "../indexer/indexStore.js";
import { processQuery } from "../processing/pipeline.js";
import { uniqueTerms } from "../ranking/scorer.js";
import type { Queryable } from "../ranking/searchStore.js";
import type { SuggestIndex } from "../search/autocomplete.js";
import { cacheKey, toCachedPage, type CachedPage, type ResultCache } from "../search/cache.js";
import type { CorpusVersion } from "../search/corpusVersion.js";
import { searchQuery } from "../search/queryProcessor.js";
import { asyncRoute, searchLimiter, suggestionsLimiter } from "./middleware.js";

/**
 * Everything the handlers need, constructed once in `server.ts`.
 *
 * Passed in rather than imported so that `routes.ts` and `server.ts` do not import each other,
 * and so a test can drive a handler against a fake `Queryable` without a live pool.
 */
export interface ApiDeps {
  //something query-able, real Postgres pool in production, a fake in tests.
  db: Queryable;
  version: CorpusVersion;
  //Where computed search results are stored so identical searches don't re-hit the database.
  cache: ResultCache;
  suggest: SuggestIndex;
}

//These two schemas are the airlock between the untrusted outside world and your trusted internal code.
const searchParams = z.object({
  q: z.string().trim().min(1, "required").max(MAX_QUERY_LENGTH),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const suggestParams = z.object({
  q: z.string().min(1, "required").max(MAX_QUERY_LENGTH),
});

//This function's job is translation: it takes CachedPage — an internal shape, shared between a freshly computed result and a cache hit — and reshapes it into SearchResponse
function toResponse(result: CachedPage, query: string): SearchResponse {
  return {
    query,
    status: result.status,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    results: result.results,
  };
}

//This is the one function the rest of the app actually calls (from server.ts). It takes the dependency bundle, builds an Express Router, 
// attaches all four endpoints to it with their specific rate limiters and handlers, and returns the finished router ready to be mounted.
export function createRouter(deps: ApiDeps): Router {
  const router = Router();

  router.get(
    "/search",
    searchLimiter,
    //asyncRoute(async (req, res) => {...}) — wraps the async logic so any thrown/rejected error (a ZodError from .parse(), 
    // a DB failure, anything) is forwarded to errorHandler instead of hanging the request.
    asyncRoute(async (req, res) => {
      const { q, page, pageSize } = searchParams.parse(req.query);

      //The stems are computed here and again inside `searchQuery`, because 3.4 keys the cache on
      //them and the cache has to be consulted before the query that produces them. Two pure
      //calls and no I/O — cheaper than keying on the raw string (which would make `Documents`
      //and `documents` two entries for one answer) or splitting the stemming back out of
      //`searchQuery` into something a caller has to remember to run first.
      const stems = uniqueTerms(processQuery(q));

      //A stopword-only query is answered without touching the cache at all. `searchQuery`
      //returns before any I/O, so there is nothing to pay back, and every such query has the
      //same empty stems — they would collide onto one key while differing only in `query`,
      //which is the field the cache does not store.
      if (stems.length === 0) {
        res.json(toResponse(await searchQuery(deps.db, { query: q, page, pageSize }), q));
        return;
      }

      //Reads the current corpus version — this ordering is critical, explained next.
      //Builds the cache key from the stems (not raw text) plus pagination.
      const version = await deps.version.current();
      const key = cacheKey(stems, page, pageSize);

      const hit = deps.cache.get(key, version);
      if (hit !== undefined) {
        res.json(toResponse(hit, q));
        return;
      }

      const result = await searchQuery(deps.db, { query: q, page, pageSize });
      //`empty-index` is cached like anything else: it is version-invalidated exactly as `ok` is,
      //and the branch that would skip it costs more than the entry does.
      deps.cache.set(key, version, toCachedPage(result));

      res.json(toResponse(result, q));
    }),
  );

  router.get(
    "/suggestions",
    suggestionsLimiter,
    asyncRoute(async (req, res) => {
      const { q } = suggestParams.parse(req.query);
      //Not trimmed, deliberately: a trailing space means the user finished a word and is not
      //typing one, which `suggest` answers with `[]`. Trimming here would offer completions for
      //the word they just finished.
      res.json(await deps.suggest.suggest(q));
    }),
  );

  //No limiter. The hosting platform polls this to decide whether the instance is alive.
  router.get(
    "/health",
    asyncRoute(async (_req, res) => {
      const [postgres, redis] = await Promise.all([checkPgHealth(), checkRedisHealth()]);
      // Postgres is a hard dependency; Redis is not (it's crawl-only and absent when hosted).
      // `redis !== false` treats "not_configured" as healthy but still fails a Redis that was
      // configured and is now unreachable.
      const ok = postgres && redis !== false;

      res.status(ok ? 200 : 503).json({
        status: ok ? "ok" : "degraded",
        dependencies: { postgres, redis },
      });
    }),
  );

  router.get(
    "/statistics",
    searchLimiter,
    asyncRoute(async (_req, res) => {
      //Both reads are independent single queries, so they go together rather than in
      //sequence — the endpoint is on the empty state's critical path.
      const [stats, sources] = await Promise.all([
        readCorpusStats(deps.db),
        readCorpusSources(deps.db),
      ]);

      const body: Statistics = {
        totalDocs: stats.totalDocs,
        totalTokens: stats.totalTokens,
        avgDocLen: stats.avgDocLen,
        sources,
        //`readCorpusStats` reports a never-indexed corpus as `0`, which would render as
        //1970-01-01 — a wrong answer where `null` is a missing one.
        updatedAt: stats.updatedAt === 0 ? null : new Date(stats.updatedAt).toISOString(),
      };

      res.json(body);
    }),
  );

  return router;
}
