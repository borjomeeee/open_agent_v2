function flattenParams(
  params: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const newKey = prefix === "" ? key : `${prefix}[${key}]`;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenParams(value as Record<string, unknown>, newKey),
      );
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const arrayKey = `${newKey}[${i}]`;
        if (typeof value[i] === "object" && value[i] !== null) {
          Object.assign(
            result,
            flattenParams(value[i] as Record<string, unknown>, arrayKey),
          );
        } else {
          result[arrayKey] = String(value[i]);
        }
      }
    } else {
      result[newKey] = String(value ?? "");
    }
  }
  return result;
}

export class BitrixService {
  constructor(
    private clientEndpoint: string,
    private accessToken: string,
  ) {}

  async call(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const url = `${this.clientEndpoint}${method}`;
    const body = new URLSearchParams(
      flattenParams({ ...params, auth: this.accessToken }),
    );

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const data = (await res.json()) as Record<string, unknown>;
    if (data.error) {
      throw new Error(
        `Bitrix error: ${data.error} — ${data.error_description}`,
      );
    }

    return data;
  }

  async sendMessage(
    dialogId: string,
    message: string,
    botId?: number,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      DIALOG_ID: dialogId,
      MESSAGE: message,
    };
    if (botId !== undefined) params.BOT_ID = botId;
    await this.call("imbot.message.add", params);
  }

  async registerBot(options: {
    code: string;
    name: string;
    workPosition: string;
    color: string;
    handlerUrl: string;
  }): Promise<number> {
    const result = await this.call("imbot.register", {
      CODE: options.code,
      TYPE: "O",
      EVENT_MESSAGE_ADD: options.handlerUrl,
      EVENT_WELCOME_MESSAGE: options.handlerUrl,
      EVENT_BOT_DELETE: options.handlerUrl,
      OPENLINE: "Y",
      PROPERTIES: {
        NAME: options.name,
        WORK_POSITION: options.workPosition,
        COLOR: options.color,
      },
    });
    return result.result as number;
  }

  async bindEvent(event: string, handlerUrl: string): Promise<void> {
    await this.call("event.bind", {
      EVENT: event,
      HANDLER: handlerUrl,
    });
  }
}
