import type { MiddlewareHandler } from "hono";
import { logger } from "./logger.ts";

const httpLog = logger.child({ module: "http" });

export const httpLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  httpLog.info(
    { method: c.req.method, path: c.req.path, status: c.res.status, durationMs: Date.now() - start },
    `${c.req.method} ${c.req.path}`,
  );
};

export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  const apiKey = process.env.API_KEY;
  if (apiKey) {
    const provided = c.req.header("X-API-Key");
    if (provided !== apiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }
  await next();
};
