import { Hono, type Context } from "hono";
import type { ChannelManager } from "../channels/manager.ts";
import type { ChannelType, ChannelConfig, TelegramConfig, CronConfig, GraphConfig } from "../channels/types.ts";
import { handleWebhookIngress } from "../channels/handlers/webhook.ts";
import { handleTelegramIngress, setTelegramWebhook, deleteTelegramWebhook } from "../channels/handlers/telegram.ts";
import { handleBitrixIngress } from "../channels/handlers/bitrix.ts";
import { startCronChannel } from "../channels/handlers/cron.ts";
import { logger } from "../logger.ts";

const log = logger.child({ module: "channels" });

export function createChannelRoutes(channelManager: ChannelManager) {
  const app = new Hono();

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

    const validTypes: ChannelType[] = ["webhook", "telegram", "cron", "graph", "bitrix"];
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
        log.info({ channelId: id, webhookUrl }, "Telegram webhook set");
      }

      if (channel.type === "cron") {
        startCronChannel(channel, channelManager);
        log.info({ channelId: id, schedule: (channel.config as CronConfig).schedule }, "Cron channel started");
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
  app.post("/bitrix/:id", (c) => handleBitrixIngress(c, channelManager));

  return app;
}

function getServerUrl(c: Context): string {
  const proto = c.req.header("x-forwarded-proto") || "http";
  const host = c.req.header("host") || "localhost";
  return `${proto}://${host}`;
}

function validateConfig(type: ChannelType, config: ChannelConfig): string | null {
  switch (type) {
    case "telegram":
      if (!(config as TelegramConfig).botToken) return "Telegram channel requires 'botToken' in config";
      break;
    case "cron": {
      const cron = config as CronConfig;
      if (!cron.schedule) return "Cron channel requires 'schedule' in config";
      if (!cron.input || typeof cron.input !== "object") return "Cron channel requires 'input' object in config";
      break;
    }
    case "graph":
      if (!(config as GraphConfig).sourceGraph) return "Graph channel requires 'sourceGraph' in config";
      break;
    case "bitrix":
      break;
  }
  return null;
}
