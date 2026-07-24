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
  const ok = postgres && redis;

  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    defaultPageSize: DEFAULT_PAGE_SIZE,
    dependencies: { postgres, redis },
  });
});

export default app;
