import cors from "cors";
import express, { Request, Response } from "express";
import { DEFAULT_PAGE_SIZE } from "shared";
import { checkPgHealth } from "../db/pg";
import { checkRedisHealth } from "../db/redis";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", async (_req: Request, res: Response) => {
  const [postgres, redis] = await Promise.all([checkPgHealth(), checkRedisHealth()]);
  // Postgres is a hard dependency; Redis is not (it's crawl-only and absent when hosted).
  // `redis !== false` treats "not_configured" as healthy but still fails a Redis that was
  // configured and is now unreachable.
  const ok = postgres && redis !== false;

  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    dependencies: { postgres, redis },
  });
});

export default app;
