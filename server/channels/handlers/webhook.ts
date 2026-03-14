import type { Context } from "hono";
import type { ChannelManager } from "../manager.ts";
import type { WebhookConfig } from "../types.ts";

export async function handleWebhookIngress(c: Context, channelManager: ChannelManager) {
  const { id } = c.req.param();
  const channel = channelManager.getChannel(id!);

  if (!channel || channel.type !== "webhook") {
    return c.json({ error: "Channel not found" }, 404);
  }

  if (!channel.active) {
    return c.json({ error: "Channel is not active" }, 400);
  }

  const config = channel.config as WebhookConfig;

  if (config.secret) {
    const signature = c.req.header("X-Hub-Signature-256");
    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const body = await c.req.text();
    const expected = await computeHmac(config.secret, body);
    if (signature !== `sha256=${expected}`) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    try {
      const input = JSON.parse(body);
      const threadId = input.thread_id ? `wh:${input.thread_id}` : undefined;
      const result = await channelManager.invokeGraph(channel.graphName, input, threadId);
      return c.json({ result });
    } catch (err: any) {
      return c.json({ error: `Invocation failed: ${err.message}` }, 500);
    }
  }

  try {
    const input = await c.req.json();
    const threadId = input.thread_id ? `wh:${input.thread_id}` : undefined;
    const result = await channelManager.invokeGraph(channel.graphName, input, threadId);
    return c.json({ result });
  } catch (err: any) {
    return c.json({ error: `Invocation failed: ${err.message}` }, 500);
  }
}

async function computeHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
