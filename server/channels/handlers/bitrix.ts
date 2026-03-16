import type { Context } from "hono";
import type { ChannelManager } from "../manager.ts";
import type { BitrixConfig } from "../types.ts";
import { logger } from "../../logger.ts";

const log = logger.child({ module: "bitrix" });

export async function handleBitrixIngress(
  c: Context,
  channelManager: ChannelManager,
) {
  const { id } = c.req.param();
  const channel = channelManager.getChannel(id!);

  if (!channel || channel.type !== "bitrix") {
    return c.json({ error: "Channel not found" }, 404);
  }

  if (!channel.active) {
    return c.json({ error: "Channel is not active" }, 400);
  }

  const config = channel.config as BitrixConfig;

  try {
    const contentType = c.req.header("content-type") ?? "";
    let body: Record<string, any>;

    if (
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded")
    ) {
      const formData = await c.req.formData();
      body = parseBracketNotation(Object.fromEntries(formData.entries()));
    } else {
      body = await c.req.json();
    }

    if (config.secret) {
      log.info({ channelId: id, body }, "Bitrix body");
      const incomingSecret = body.auth?.client_id ?? body.secret;
      if (incomingSecret !== config.secret) {
        return c.json({ error: "Invalid secret" }, 401);
      }
    }

    const chatEntityId = body.data?.PARAMS?.CHAT_ENTITY_ID;
    const threadId = chatEntityId ? `bx:${chatEntityId}` : undefined;

    channelManager.invokeGraph(channel.graphName, body, threadId, {
      onComplete: async () => {},
      onError: async (err) => {
        log.error(
          { channelId: id, err },
          "Graph run failed for Bitrix channel",
        );
      },
    });

    return c.json({ ok: true });
  } catch (err: any) {
    log.error({ channelId: id, err }, "Bitrix channel error");
    return c.json({ ok: true });
  }
}

function parseBracketNotation(flat: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split("[").map((p) => p.replace("]", ""));
    let cursor: Record<string, any> = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (typeof cursor[part] !== "object" || cursor[part] === null) {
        cursor[part] = {};
      }
      cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]!] = value;
  }

  return result;
}
