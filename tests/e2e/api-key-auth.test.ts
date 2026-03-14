import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startE2EServer,
  e2eFetch,
  e2eDeployGraph,
  type E2EContext,
} from "../helpers/e2e-setup.ts";

describe("E2E: API key authentication", () => {
  let ctx: E2EContext;
  const API_KEY = "e2e-test-api-key";

  beforeEach(async () => {
    ctx = await startE2EServer({ apiKey: API_KEY });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET /health does not require API key", async () => {
    const res = await e2eFetch(ctx.baseUrl, "/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  test("API routes reject requests without API key", async () => {
    const res = await e2eFetch(ctx.baseUrl, "/api/graphs");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("API routes reject requests with wrong API key", async () => {
    const res = await e2eFetch(ctx.baseUrl, "/api/graphs", {
      headers: { "X-API-Key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  test("API routes accept requests with correct API key", async () => {
    const res = await e2eFetch(ctx.baseUrl, "/api/graphs", {
      headers: { "X-API-Key": API_KEY },
    });
    expect(res.status).toBe(200);
  });

  test("full workflow with API key: deploy → channel → webhook (no auth)", async () => {
    const deployRes = await e2eDeployGraph(ctx.baseUrl, "echo", { apiKey: API_KEY });
    expect(deployRes.status).toBe(200);

    const createRes = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      headers: { "X-API-Key": API_KEY },
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    expect(createRes.status).toBe(201);
    const { channel } = await createRes.json();

    const startRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/start`, {
      method: "POST",
      headers: { "X-API-Key": API_KEY },
    });
    expect(startRes.status).toBe(200);

    const hookRes = await e2eFetch(ctx.baseUrl, `/hooks/${channel.id}`, {
      method: "POST",
      body: JSON.stringify({ message: "auth-e2e" }),
    });
    expect(hookRes.status).toBe(200);
    const body = await hookRes.json();
    expect(body.result.echo).toEqual({ message: "auth-e2e" });
  });

  test("all /api/* sub-routes are protected", async () => {
    const routes = [
      { path: "/api/graphs", method: "GET" },
      { path: "/api/channels", method: "GET" },
      { path: "/api/queue/stats", method: "GET" },
    ];

    for (const route of routes) {
      const res = await e2eFetch(ctx.baseUrl, route.path, {
        method: route.method,
      });
      expect(res.status).toBe(401);
    }
  });
});
