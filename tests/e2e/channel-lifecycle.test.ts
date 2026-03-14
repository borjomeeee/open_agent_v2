import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startE2EServer,
  e2eFetch,
  e2eDeployGraph,
  json,
  type E2EContext,
} from "../helpers/e2e-setup.ts";

describe("E2E: Channel lifecycle", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await startE2EServer();
    await e2eDeployGraph(ctx.baseUrl, "echo");
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("full channel lifecycle: create → get → update → start → stop → delete", async () => {
    const createRes = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    expect(createRes.status).toBe(201);
    const { channel } = await json(createRes);
    expect(channel.type).toBe("webhook");
    expect(channel.active).toBe(false);

    const getRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}`);
    expect(getRes.status).toBe(200);
    const detail = await json(getRes);
    expect(detail.id).toBe(channel.id);

    const updateRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}`, {
      method: "PUT",
      body: JSON.stringify({ config: { secret: "updated-secret" } }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await json(updateRes);
    expect(updated.channel.config.secret).toBe("updated-secret");

    const startRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/start`, {
      method: "POST",
    });
    expect(startRes.status).toBe(200);
    const started = await json(startRes);
    expect(started.channel.active).toBe(true);

    const stopRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/stop`, {
      method: "POST",
    });
    expect(stopRes.status).toBe(200);
    const stopped = await json(stopRes);
    expect(stopped.channel.active).toBe(false);

    const deleteRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const listRes = await e2eFetch(ctx.baseUrl, "/api/channels");
    const { channels } = await json(listRes);
    expect(channels.length).toBe(0);
  });

  test("cannot update an active channel", async () => {
    const createRes = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/start`, {
      method: "POST",
    });

    const updateRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}`, {
      method: "PUT",
      body: JSON.stringify({ config: { secret: "x" } }),
    });
    expect(updateRes.status).toBe(400);
    const body = await json(updateRes);
    expect(body.error).toContain("Stop the channel");
  });

  test("cannot activate channel when graph is stopped", async () => {
    const createRes = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    await e2eFetch(ctx.baseUrl, "/api/graphs/echo/stop", { method: "POST" });

    const startRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/start`, {
      method: "POST",
    });
    expect(startRes.status).toBe(400);
    const body = await json(startRes);
    expect(body.error).toContain("not active");
  });

  test("create multiple channels for same graph and filter by graph", async () => {
    await e2eDeployGraph(ctx.baseUrl, "other");

    await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "other", config: {} }),
    });

    const allRes = await e2eFetch(ctx.baseUrl, "/api/channels");
    const { channels: all } = await json(allRes);
    expect(all.length).toBe(3);

    const filteredRes = await e2eFetch(ctx.baseUrl, "/api/channels?graph=echo");
    const { channels: filtered } = await json(filteredRes);
    expect(filtered.length).toBe(2);
    for (const ch of filtered) {
      expect(ch.graphName).toBe("echo");
    }
  });

  test("cron channel create and delete", async () => {
    const createRes = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({
        type: "cron",
        graphName: "echo",
        config: { schedule: "*/5 * * * *", input: { msg: "tick" } },
      }),
    });
    expect(createRes.status).toBe(201);
    const { channel } = await json(createRes);
    expect(channel.type).toBe("cron");

    const deleteRes = await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
  });

  test("create channel for unknown graph fails", async () => {
    const res = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "nonexistent", config: {} }),
    });
    expect(res.status).toBe(400);
  });

  test("create channel with invalid type fails", async () => {
    const res = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "invalid", graphName: "echo", config: {} }),
    });
    expect(res.status).toBe(400);
  });
});
