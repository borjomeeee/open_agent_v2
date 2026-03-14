import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startE2EServer,
  e2eFetch,
  e2eDeployGraph,
  json,
  computeHmac,
  FAILING_GRAPH_CODE,
  type E2EContext,
} from "../helpers/e2e-setup.ts";

async function setupWebhookChannel(
  baseUrl: string,
  opts?: { secret?: string },
): Promise<string> {
  const res = await e2eFetch(baseUrl, "/api/channels", {
    method: "POST",
    body: JSON.stringify({
      type: "webhook",
      graphName: "echo",
      config: opts?.secret ? { secret: opts.secret } : {},
    }),
  });
  const { channel } = await json(res);

  await e2eFetch(baseUrl, `/api/channels/${channel.id}/start`, {
    method: "POST",
  });
  return channel.id;
}

describe("E2E: Webhook pipeline", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await startE2EServer();
    await e2eDeployGraph(ctx.baseUrl, "echo");
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("deploy → create channel → activate → trigger → get result", async () => {
    const channelId = await setupWebhookChannel(ctx.baseUrl);

    const triggerRes = await e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ message: "hello e2e" }),
    });
    expect(triggerRes.status).toBe(200);
    const body = await json(triggerRes);
    expect(body.result).toBeDefined();
    expect(body.result.echo).toEqual({ message: "hello e2e" });
  });

  test("webhook preserves thread_id in the payload", async () => {
    const channelId = await setupWebhookChannel(ctx.baseUrl);

    const res = await e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ data: "test", thread_id: "thread-42" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.result.echo).toHaveProperty("thread_id", "thread-42");
  });

  test("multiple webhook triggers return independent results", async () => {
    const channelId = await setupWebhookChannel(ctx.baseUrl);

    const [res1, res2] = await Promise.all([
      e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
        method: "POST",
        body: JSON.stringify({ seq: 1 }),
      }),
      e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
        method: "POST",
        body: JSON.stringify({ seq: 2 }),
      }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = await json(res1);
    const body2 = await json(res2);
    expect(body1.result.echo.seq).toBe(1);
    expect(body2.result.echo.seq).toBe(2);
  });

  test("channel lifecycle: create → start → stop → trigger fails → restart → trigger succeeds", async () => {
    const createRes = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/start`, {
      method: "POST",
    });

    await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/stop`, {
      method: "POST",
    });

    const failRes = await e2eFetch(ctx.baseUrl, `/hooks/${channel.id}`, {
      method: "POST",
      body: JSON.stringify({ data: "x" }),
    });
    expect(failRes.status).toBe(400);

    await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/start`, {
      method: "POST",
    });

    const okRes = await e2eFetch(ctx.baseUrl, `/hooks/${channel.id}`, {
      method: "POST",
      body: JSON.stringify({ data: "ok" }),
    });
    expect(okRes.status).toBe(200);
    const body = await json(okRes);
    expect(body.result.echo).toEqual({ data: "ok" });
  });

  test("deleting channel with active webhook makes hook return 404", async () => {
    const channelId = await setupWebhookChannel(ctx.baseUrl);

    await e2eFetch(ctx.baseUrl, `/api/channels/${channelId}`, {
      method: "DELETE",
    });

    const res = await e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ data: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("E2E: HMAC-signed webhooks", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await startE2EServer();
    await e2eDeployGraph(ctx.baseUrl, "echo");
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("valid HMAC signature is accepted", async () => {
    const secret = "e2e-hmac-secret";
    const channelId = await setupWebhookChannel(ctx.baseUrl, { secret });

    const payload = JSON.stringify({ message: "signed" });
    const hmac = await computeHmac(secret, payload);

    const res = await fetch(`${ctx.baseUrl}/hooks/${channelId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${hmac}`,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.result.echo).toEqual({ message: "signed" });
  });

  test("missing HMAC signature is rejected", async () => {
    const secret = "e2e-hmac-secret";
    const channelId = await setupWebhookChannel(ctx.baseUrl, { secret });

    const res = await e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ data: "unsigned" }),
    });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error).toContain("Missing signature");
  });

  test("wrong HMAC signature is rejected", async () => {
    const secret = "e2e-hmac-secret";
    const channelId = await setupWebhookChannel(ctx.baseUrl, { secret });

    const res = await fetch(`${ctx.baseUrl}/hooks/${channelId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=deadbeef",
      },
      body: JSON.stringify({ data: "tampered" }),
    });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error).toContain("Invalid signature");
  });
});

describe("E2E: Webhook error handling", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await startE2EServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("webhook to unknown channel returns 404", async () => {
    const res = await e2eFetch(ctx.baseUrl, "/hooks/nonexistent", {
      method: "POST",
      body: JSON.stringify({ data: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("webhook to inactive channel returns 400", async () => {
    await e2eDeployGraph(ctx.baseUrl, "echo");

    const createRes = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    const res = await e2eFetch(ctx.baseUrl, `/hooks/${channel.id}`, {
      method: "POST",
      body: JSON.stringify({ data: "x" }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("not active");
  });

  test("webhook to a graph that throws returns 500", async () => {
    await e2eDeployGraph(ctx.baseUrl, "echo", { code: FAILING_GRAPH_CODE });

    const channelId = await setupWebhookChannel(ctx.baseUrl);

    const res = await e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ data: "boom" }),
    });
    expect(res.status).toBe(500);
  });
});
