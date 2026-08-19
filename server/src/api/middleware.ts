import type { NextFunction, Request, RequestHandler, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";

/**
 * Per-IP request budgets.
 *
 * Two limiters rather than one, because a single number cannot serve both endpoints:
 * `/suggestions` fires while someone is typing and `/search` fires when they stop, so a limit
 * low enough to protect search is spent on one word, and a limit loose enough for keystrokes
 * does not limit search at all.
 *
 * `/health` deliberately gets none — the hosting platform pings it, and a 429 there reads as an
 * unhealthy instance and gets the process restarted.
 */
export const RATE_LIMITS = {
  windowMs: 60_000,
  /** `/search` and `/statistics`: one submitted query at a time, generously. */
  search: 60,
  /** `/suggestions`: 5/second, which is faster than anyone types even undebounced. */
  suggestions: 300,
} as const;

//Note for 5.6, which owns rate-limit edge tests: these stores are per-process and shared by
//every test in a run, so a suite that issues more than `search` requests to /search will start
//seeing 429s in whichever test happens to be last. Testing the limiter means resetting it (the
//middleware exposes `resetKey`) rather than raising the numbers.
export const searchLimiter = rateLimit({
  windowMs: RATE_LIMITS.windowMs,
  limit: RATE_LIMITS.search,
  //7"	Tells the middleware to attach RateLimit-Limit, RateLimit-Remaining, and RateLimit-Reset headers to every response,
  standardHeaders: "draft-7",
  //Disables the older, non-standard X-RateLimit-* headers. No need to send both formats.
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

export const suggestionsLimiter = rateLimit({
  windowMs: RATE_LIMITS.windowMs,
  limit: RATE_LIMITS.suggestions,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

/**
 * Forward a rejected handler to the error handler.
 *
 * Express 4 does not do this itself: an async handler that rejects leaves the request hanging
 * with no response until the client gives up, which is worse than a 500 and invisible to any
 * test that only asserts the happy path. Express 5 forwards rejections natively, but adopting it
 * for this turns `req.query` into a getter and changes path matching — a framework major to
 * avoid five lines, in the layer whose whole job is composition.
 */
export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

/**
 * The single error handler: log the real failure, tell the caller as little as possible.
 *
 * A zod failure is the caller's fault and answers 400, but with one flat string rather than
 * zod's issue tree — the tree describes our schema to a stranger. Everything else is ours and
 * answers a generic 500: a Postgres error message on the wire names our columns.
 */
//Express 4 identifies an error handler by arity, so `next` must stay in the signature even
//though nothing calls it. Same for the eslint-style unused marker: renaming it breaks the
//detection.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const path = issue?.path.join(".");
    res.status(400).json({
      error: path ? `${path}: ${issue?.message}` : (issue?.message ?? "Invalid request"),
    });
    return;
  }

  console.error("Unhandled error while serving a request", err);
  res.status(500).json({ error: "Internal error" });
}
