import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestServer,
  deployMockGraph,
  mockGraphCode,
  mockBuilderGraphCode,
  type TestContext,
  req,
  json,
} from "../helpers/setup.ts";

describe("Graph routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ─── List / Get ───────────────────────────────────────────────

  test("GET /api/graphs returns empty list initially", async () => {
    const res = await req(ctx.app, "/api/graphs");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.graphs).toEqual([]);
  });

  test("GET /api/graphs/:name returns 404 for unknown graph", async () => {
    const res = await req(ctx.app, "/api/graphs/nope");
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error).toBe("Graph not found");
  });

  // ─── Deploy ───────────────────────────────────────────────────

  test("POST /api/graphs/deploy deploys and activates a graph", async () => {
    const res = await deployMockGraph(ctx.app, "echo");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.message).toContain("deployed and activated");
    expect(body.exports).toContain("graph");
    expect(body.activeExport).toBe("graph");
  });

  test("deploy requires name and code", async () => {
    const res = await req(ctx.app, "/api/graphs/deploy", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("Missing");
  });

  test("deploy rejects code with no graph exports", async () => {
    const res = await deployMockGraph(ctx.app, "bad", "module.exports.foo = 42;");
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("No compiled LangGraph instances");
  });

  test("deploying same name overwrites previous graph", async () => {
    await deployMockGraph(ctx.app, "echo");
    const res2 = await deployMockGraph(ctx.app, "echo");
    expect(res2.status).toBe(200);

    const list = await req(ctx.app, "/api/graphs");
    const body = await json(list);
    expect(body.graphs.length).toBe(1);
  });

  test("deploy with builder(env) pattern works", async () => {
    const res = await deployMockGraph(ctx.app, "builder-graph", mockBuilderGraphCode());
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.exports).toContain("builder");
  });

  // ─── Get after deploy ─────────────────────────────────────────

  test("GET /api/graphs/:name returns deployed graph", async () => {
    await deployMockGraph(ctx.app, "echo");
    const res = await req(ctx.app, "/api/graphs/echo");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.name).toBe("echo");
    expect(body.active).toBe(true);
    expect(body.exports).toContain("graph");
  });

  test("GET /api/graphs lists deployed graphs", async () => {
    await deployMockGraph(ctx.app, "a");
    await deployMockGraph(ctx.app, "b");
    const res = await req(ctx.app, "/api/graphs");
    const body = await json(res);
    expect(body.graphs.length).toBe(2);
    const names = body.graphs.map((g: any) => g.name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  // ─── Start / Stop ─────────────────────────────────────────────

  test("POST /:name/stop deactivates a graph", async () => {
    await deployMockGraph(ctx.app, "echo");
    const res = await req(ctx.app, "/api/graphs/echo/stop", { method: "POST" });
    expect(res.status).toBe(200);

    const entry = await req(ctx.app, "/api/graphs/echo");
    const body = await json(entry);
    expect(body.active).toBe(false);
  });

  test("POST /:name/start reactivates a stopped graph", async () => {
    await deployMockGraph(ctx.app, "echo");
    await req(ctx.app, "/api/graphs/echo/stop", { method: "POST" });

    const res = await req(ctx.app, "/api/graphs/echo/start", { method: "POST" });
    expect(res.status).toBe(200);

    const entry = await req(ctx.app, "/api/graphs/echo");
    const body = await json(entry);
    expect(body.active).toBe(true);
  });

  test("start on already active graph returns success", async () => {
    await deployMockGraph(ctx.app, "echo");
    const res = await req(ctx.app, "/api/graphs/echo/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.message).toContain("already active");
  });

  test("start/stop on unknown graph returns 404", async () => {
    const r1 = await req(ctx.app, "/api/graphs/nope/start", { method: "POST" });
    expect(r1.status).toBe(404);
    const r2 = await req(ctx.app, "/api/graphs/nope/stop", { method: "POST" });
    expect(r2.status).toBe(404);
  });

  // ─── Env management ───────────────────────────────────────────

  test("GET /:name/env returns empty env initially", async () => {
    await deployMockGraph(ctx.app, "echo");
    const res = await req(ctx.app, "/api/graphs/echo/env");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.env).toEqual({});
  });

  test("PUT /:name/env sets and masks env vars", async () => {
    await deployMockGraph(ctx.app, "echo");

    const putRes = await req(ctx.app, "/api/graphs/echo/env", {
      method: "PUT",
      body: JSON.stringify({ vars: { SECRET: "my-super-secret-value" } }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await req(ctx.app, "/api/graphs/echo/env");
    const body = await json(getRes);
    expect(body.env.SECRET).not.toBe("my-super-secret-value");
    expect(body.env.SECRET).toContain("****");
  });

  test("PUT /:name/env requires vars object", async () => {
    await deployMockGraph(ctx.app, "echo");
    const res = await req(ctx.app, "/api/graphs/echo/env", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("PUT /:name/env on unknown graph returns 404", async () => {
    const res = await req(ctx.app, "/api/graphs/nope/env", {
      method: "PUT",
      body: JSON.stringify({ vars: { A: "B" } }),
    });
    expect(res.status).toBe(404);
  });

  test("deploy with env vars passes them to the graph", async () => {
    const res = await req(ctx.app, "/api/graphs/deploy", {
      method: "POST",
      body: JSON.stringify({
        name: "env-graph",
        code: mockBuilderGraphCode(),
        env: { MY_VAR: "hello" },
      }),
    });
    expect(res.status).toBe(200);

    const envRes = await req(ctx.app, "/api/graphs/env-graph/env");
    const body = await json(envRes);
    expect(body.env).toHaveProperty("MY_VAR");
  });

  // ─── Delete ───────────────────────────────────────────────────

  test("DELETE /:name removes a graph", async () => {
    await deployMockGraph(ctx.app, "echo");
    const res = await req(ctx.app, "/api/graphs/echo", { method: "DELETE" });
    expect(res.status).toBe(200);

    const list = await req(ctx.app, "/api/graphs");
    const body = await json(list);
    expect(body.graphs.length).toBe(0);
  });

  test("DELETE unknown graph returns 404", async () => {
    const res = await req(ctx.app, "/api/graphs/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
