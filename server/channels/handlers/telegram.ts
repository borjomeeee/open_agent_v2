import type { Context } from "hono";
import type { ChannelManager } from "../manager.ts";
import type { TelegramConfig } from "../types.ts";

export async function handleTelegramIngress(c: Context, channelManager: ChannelManager) {
  const { id } = c.req.param();
  const channel = channelManager.getChannel(id!);

  if (!channel || channel.type !== "telegram") {
    return c.json({ error: "Channel not found" }, 404);
  }

  if (!channel.active) {
    return c.json({ error: "Channel is not active" }, 400);
  }

  const config = channel.config as TelegramConfig;

  try {
    const update = await c.req.json();

    const message = update.message || update.edited_message;
    if (!message?.text) {
      return c.json({ ok: true });
    }

    const input = {
      message: message.text,
      chat_id: message.chat.id,
      user: {
        id: message.from?.id,
        first_name: message.from?.first_name,
        last_name: message.from?.last_name,
        username: message.from?.username,
      },
      message_id: message.message_id,
    };

    const result = await channelManager.invokeGraph(channel.graphName, input);

    const replyText = typeof result === "string"
      ? result
      : result?.message ?? result?.answer ?? result?.response ?? JSON.stringify(result);

    await sendTelegramMessage(config.botToken, message.chat.id, replyText);

    return c.json({ ok: true });
  } catch (err: any) {
    console.error(`Telegram channel ${id} error: ${err.message}`);
    return c.json({ ok: true });
  }
}

export async function setTelegramWebhook(botToken: string, webhookUrl: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });

  if (!res.ok) {
    const body = await res.json() as any;
    throw new Error(`Failed to set Telegram webhook: ${body.description || res.statusText}`);
  }
}

export async function deleteTelegramWebhook(botToken: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
    method: "POST",
  });

  if (!res.ok) {
    const body = await res.json() as any;
    throw new Error(`Failed to delete Telegram webhook: ${body.description || res.statusText}`);
  }
}

async function sendTelegramMessage(botToken: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
