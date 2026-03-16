import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestServer,
  deployMockGraph,
  type TestContext,
  req,
  json,
} from "../helpers/setup.ts";

async function computeHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createWebhookChannel(
  ctx: TestContext,
  opts?: { secret?: string },
): Promise<string> {
  const res = await req(ctx.app, "/api/channels", {
    method: "POST",
    body: JSON.stringify({
      type: "webhook",
      graphName: "echo",
      config: opts?.secret ? { secret: opts.secret } : {},
    }),
  });
  const { channel } = await json(res);

  await req(ctx.app, `/api/channels/${channel.id}/start`, { method: "POST" });
  return channel.id;
}

describe("Webhook ingress", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
    await deployMockGraph(ctx.app, "echo");
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("POST /hooks/:id invokes graph and returns result", async () => {
    const channelId = await createWebhookChannel(ctx);

    const res = await req(ctx.app, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.result).toBeDefined();
    expect(body.result.echo).toEqual({ input: [{ message: "hello" }] });
  });

  test("webhook with thread_id passes it through", async () => {
    const channelId = await createWebhookChannel(ctx);

    const res = await req(ctx.app, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ message: "hi", thread_id: "t1" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.result.echo).toHaveProperty("thread_id", "t1");
  });

  test("webhook to unknown channel returns 404", async () => {
    const res = await req(ctx.app, "/hooks/nonexistent", {
      method: "POST",
      body: JSON.stringify({ data: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("webhook to inactive channel returns 400", async () => {
    const createRes = await req(ctx.app, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    const res = await req(ctx.app, `/hooks/${channel.id}`, {
      method: "POST",
      body: JSON.stringify({ data: "x" }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain("not active");
  });

  // ─── HMAC-signed webhooks ─────────────────────────────────────

  test("HMAC webhook accepts valid signature", async () => {
    const secret = "my-webhook-secret";
    const channelId = await createWebhookChannel(ctx, { secret });

    const payload = JSON.stringify({ message: "signed" });
    const hmac = await computeHmac(secret, payload);

    const res = await ctx.app.request(`/hooks/${channelId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${hmac}`,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.result.echo).toEqual({ input: [{ message: "signed" }] });
  });

  test("HMAC webhook rejects missing signature", async () => {
    const secret = "my-webhook-secret";
    const channelId = await createWebhookChannel(ctx, { secret });

    const res = await req(ctx.app, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ message: "unsigned" }),
    });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error).toContain("Missing signature");
  });

  test("HMAC webhook rejects wrong signature", async () => {
    const secret = "my-webhook-secret";
    const channelId = await createWebhookChannel(ctx, { secret });

    const res = await ctx.app.request(`/hooks/${channelId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=badhash",
      },
      body: JSON.stringify({ message: "tampered" }),
    });
    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.error).toContain("Invalid signature");
  });

  // ─── Webhook does not require API key ─────────────────────────

  test("webhook ingress bypasses API key auth", async () => {
    await ctx.cleanup();
    ctx = await createTestServer({ apiKey: "secret-api-key" });
    await deployMockGraph(ctx.app, "echo", undefined, {
      "X-API-Key": "secret-api-key",
    });

    const createRes = await ctx.app.request("/api/channels", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "secret-api-key",
      },
      body: JSON.stringify({ type: "webhook", graphName: "echo", config: {} }),
    });
    const { channel } = await json(createRes);

    await ctx.app.request(`/api/channels/${channel.id}/start`, {
      method: "POST",
      headers: { "X-API-Key": "secret-api-key" },
    });

    const res = await req(ctx.app, `/hooks/${channel.id}`, {
      method: "POST",
      body: JSON.stringify({ message: "no-api-key" }),
    });
    expect(res.status).toBe(200);
  });
});
