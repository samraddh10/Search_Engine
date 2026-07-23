import cors from "cors";
import express, { Request, Response } from "express";
import { DEFAULT_PAGE_SIZE } from "shared";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", defaultPageSize: DEFAULT_PAGE_SIZE });
});

export default app;
