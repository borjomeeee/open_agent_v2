import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestServer,
  deployMockGraph,
  type TestContext,
  req,
  json,
} from "../helpers/setup.ts";

describe("Channel routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    await deployMockGraph(ctx.app, "echo");
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ─── List / Get ───────────────────────────────────────────────

  test("GET /api/channels returns empty list initially", async () => {
    const res = await req(ctx.app, "/api/channels");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.channels).toEqual([]);
  });

  test("GET /api/channels/:id returns 404 for unknown channel", async () => {
    const res = await req(ctx.app, "/api/channels/nonexistent");
    expect(res.status).toBe(404);
  });

  // ─── Create webhook channel ───────────────────────────────────

  test("POST /api/channels creates a webhook channel", async () => {
    const res = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "webhook",
        graphName: "echo",
        config: {},
      }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.channel.type).toBe("webhook");
    expect(body.channel.graphName).toBe("echo");
    expect(body.channel.active).toBe(false);
    expect(body.channel.id).toBeDefined();
  });

  test("create channel for unknown graph fails", async () => {
    const res = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "webhook",
        graphName: "nonexistent",
        config: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  test("create channel with invalid type fails", async () => {
    const res = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "invalid",
        graphName: "echo",
        config: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  test("create channel with missing fields fails", async () => {
    const res = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook" }),
    });
    expect(res.status).toBe(400);
  });

  // ─── Create cron channel with validation ──────────────────────

  test("create cron channel requires schedule and input", async () => {
    const res = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "cron",
        graphName: "echo",
        config: {},
      }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("schedule");
  });

  test("create cron channel with valid config succeeds", async () => {
    const res = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "cron",
        graphName: "echo",
        config: { schedule: "*/5 * * * *", input: { msg: "tick" } },
      }),
    });
    expect(res.status).toBe(201);
  });

  // ─── Create graph channel with validation ─────────────────────

  test("create graph channel requires sourceGraph", async () => {
    const res = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "graph",
        graphName: "echo",
        config: {},
      }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("sourceGraph");
  });

  test("create graph channel with valid config succeeds", async () => {
    const res = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "graph",
        graphName: "echo",
        config: { sourceGraph: "other" },
      }),
    });
    expect(res.status).toBe(201);
  });

  // ─── Get / List after create ──────────────────────────────────

  test("GET /api/channels/:id returns created channel", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "webhook",
        graphName: "echo",
        config: {},
      }),
    });
    const { channel } = await json(createRes);

    const res = await req(ctx.app, `/api/channels/${channel.id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).toBe(channel.id);
  });

  test("list channels filters by graph name", async () => {
    await deployMockGraph(ctx.app, "other");
    await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "other", config: {} }),
    });

    const res = await req(ctx.app, "/api/channels?graph=echo");
    const body = await json(res);
    expect(body.channels.length).toBe(1);
    expect(body.channels[0].graphName).toBe("echo");
  });

  // ─── Activate / Deactivate ────────────────────────────────────

  test("POST /:id/start activates a webhook channel", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    const res = await req(ctx.app, `/api/channels/${channel.id}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.channel.active).toBe(true);
  });

  test("POST /:id/stop deactivates a channel", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    await req(ctx.app, `/api/channels/${channel.id}/start`, { method: "POST" });
    const res = await req(ctx.app, `/api/channels/${channel.id}/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.channel.active).toBe(false);
  });

  test("activate fails when graph is not active", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    await req(ctx.app, "/api/graphs/echo/stop", { method: "POST" });

    const res = await req(ctx.app, `/api/channels/${channel.id}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("not active");
  });

  test("activate unknown channel returns error", async () => {
    const res = await req(ctx.app, "/api/channels/nonexistent/start", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  // ─── Update ───────────────────────────────────────────────────

  test("PUT /:id updates channel config", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "webhook",
        graphName: "echo",
        config: {},
      }),
    });
    const { channel } = await json(createRes);

    const res = await req(ctx.app, `/api/channels/${channel.id}`, {
      method: "PUT",
      body: JSON.stringify({ config: { secret: "new-secret" } }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.channel.config.secret).toBe("new-secret");
  });

  test("update active channel fails", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    await req(ctx.app, `/api/channels/${channel.id}/start`, { method: "POST" });

    const res = await req(ctx.app, `/api/channels/${channel.id}`, {
      method: "PUT",
      body: JSON.stringify({ config: { secret: "x" } }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("Stop the channel");
  });

  test("update unknown channel returns error", async () => {
    const res = await req(ctx.app, "/api/channels/nonexistent", {
      method: "PUT",
      body: JSON.stringify({ config: {} }),
    });
    expect(res.status).toBe(400);
  });

  test("update without config returns 400", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    const res = await req(ctx.app, `/api/channels/${channel.id}`, {
      method: "PUT",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // ─── Delete ───────────────────────────────────────────────────

  test("DELETE /:id removes a channel", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    const res = await req(ctx.app, `/api/channels/${channel.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const list = await req(ctx.app, "/api/channels");
    const body = await json(list);
    expect(body.channels.length).toBe(0);
  });

  test("DELETE unknown channel returns 404", async () => {
    const res = await req(ctx.app, "/api/channels/nonexistent", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  test("DELETE active channel deactivates it first", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    await req(ctx.app, `/api/channels/${channel.id}/start`, { method: "POST" });

    const res = await req(ctx.app, `/api/channels/${channel.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
  });
});
