import { Hono } from "hono";
import type { ChannelManager } from "./manager.ts";
import type { ChannelType, ChannelConfig, WebhookConfig, TelegramConfig, CronConfig, GraphConfig } from "./types.ts";
import { handleWebhookIngress } from "./handlers/webhook.ts";
import { handleTelegramIngress, setTelegramWebhook, deleteTelegramWebhook } from "./handlers/telegram.ts";
import { startCronChannel } from "./handlers/cron.ts";

export function createChannelRoutes(channelManager: ChannelManager) {
  const app = new Hono();

  // ─── Channel management (protected by API key via parent mount) ──

  app.get("/", (c) => {
    const graphName = c.req.query("graph");
    const channels = channelManager.listAll(graphName);
    return c.json({ channels });
  });

  app.get("/:id", (c) => {
    const { id } = c.req.param();
    const channel = channelManager.getChannel(id);
    if (!channel) {
      return c.json({ error: "Channel not found" }, 404);
    }
    return c.json(channel);
  });

  app.post("/", async (c) => {
    const body = await c.req.json();
    const { type, graphName, config } = body as {
      type: ChannelType;
      graphName: string;
      config: ChannelConfig;
    };

    if (!type || !graphName || !config) {
      return c.json({ error: "Missing 'type', 'graphName', or 'config'" }, 400);
    }

    const validTypes: ChannelType[] = ["webhook", "telegram", "cron", "graph"];
    if (!validTypes.includes(type)) {
      return c.json({ error: `Invalid type. Must be one of: ${validTypes.join(", ")}` }, 400);
    }

    const validationError = validateConfig(type, config);
    if (validationError) {
      return c.json({ error: validationError }, 400);
    }

    try {
      const channel = await channelManager.create(type, graphName, config);
      return c.json({ message: `Channel created`, channel }, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.put("/:id", async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json();
    const { config } = body as { config: ChannelConfig };

    if (!config) {
      return c.json({ error: "Missing 'config'" }, 400);
    }

    try {
      const channel = await channelManager.update(id, config);
      return c.json({ message: "Channel updated", channel });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.delete("/:id", async (c) => {
    const { id } = c.req.param();
    const channel = channelManager.getChannel(id);

    if (!channel) {
      return c.json({ error: "Channel not found" }, 404);
    }

    if (channel.active && channel.type === "telegram") {
      try {
        await deleteTelegramWebhook((channel.config as TelegramConfig).botToken);
      } catch { /* best effort */ }
    }

    const removed = await channelManager.remove(id);
    if (!removed) {
      return c.json({ error: "Channel not found" }, 404);
    }

    return c.json({ message: "Channel removed" });
  });

  app.post("/:id/start", async (c) => {
    const { id } = c.req.param();

    try {
      const channel = await channelManager.activate(id);

      if (channel.type === "telegram") {
        const config = channel.config as TelegramConfig;
        const serverUrl = getServerUrl(c);
        const webhookUrl = `${serverUrl}/hooks/telegram/${channel.id}`;
        await setTelegramWebhook(config.botToken, webhookUrl);
        console.log(`Telegram webhook set for channel ${id}: ${webhookUrl}`);
      }

      if (channel.type === "cron") {
        startCronChannel(channel, channelManager);
        console.log(`Cron channel ${id} started with schedule: ${(channel.config as CronConfig).schedule}`);
      }

      return c.json({ message: `Channel activated`, channel });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post("/:id/stop", async (c) => {
    const { id } = c.req.param();

    try {
      const channel = channelManager.getChannel(id);
      if (channel?.type === "telegram" && channel.active) {
        try {
          await deleteTelegramWebhook((channel.config as TelegramConfig).botToken);
        } catch { /* best effort */ }
      }

      const updated = await channelManager.deactivate(id);
      return c.json({ message: "Channel deactivated", channel: updated });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  return app;
}

export function createIngressRoutes(channelManager: ChannelManager) {
  const app = new Hono();

  app.post("/:id", (c) => handleWebhookIngress(c, channelManager));
  app.post("/telegram/:id", (c) => handleTelegramIngress(c, channelManager));

  return app;
}

function getServerUrl(c: any): string {
  const proto = c.req.header("x-forwarded-proto") || "http";
  const host = c.req.header("host") || "localhost";
  return `${proto}://${host}`;
}

function validateConfig(type: ChannelType, config: any): string | null {
  switch (type) {
    case "telegram":
      if (!config.botToken) return "Telegram channel requires 'botToken' in config";
      break;
    case "cron":
      if (!config.schedule) return "Cron channel requires 'schedule' in config";
      if (!config.input || typeof config.input !== "object") return "Cron channel requires 'input' object in config";
      break;
    case "graph":
      if (!config.sourceGraph) return "Graph channel requires 'sourceGraph' in config";
      break;
  }
  return null;
}
