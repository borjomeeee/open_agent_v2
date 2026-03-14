import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestServer, type TestContext, req, json } from "../helpers/setup.ts";

describe("Server basics", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("GET /health returns ok", async () => {
    const res = await req(ctx.app, "/health");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "ok" });
  });

  test("GET /api/queue/stats returns counts", async () => {
    const res = await req(ctx.app, "/api/queue/stats");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toHaveProperty("active");
    expect(body).toHaveProperty("pending");
    expect(body.active).toBe(0);
    expect(body.pending).toBe(0);
  });

  test("unknown route returns 404", async () => {
    const res = await req(ctx.app, "/api/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("API key auth middleware", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer({ apiKey: "test-secret-key" });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("rejects /api/* without API key", async () => {
    const res = await req(ctx.app, "/api/graphs");
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error).toBe("Unauthorized");
  });

  test("rejects /api/* with wrong API key", async () => {
    const res = await req(ctx.app, "/api/graphs", {
      headers: { "X-API-Key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  test("passes /api/* with correct API key", async () => {
    const res = await req(ctx.app, "/api/graphs", {
      headers: { "X-API-Key": "test-secret-key" },
    });
    expect(res.status).toBe(200);
  });

  test("GET /health does not require API key", async () => {
    const res = await req(ctx.app, "/health");
    expect(res.status).toBe(200);
  });
});
