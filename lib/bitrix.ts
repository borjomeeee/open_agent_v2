export class BitrixService {
  constructor(
    private domain: string,
    private accessToken: string,
    private botId?: number,
  ) {}

  async sendMessage(dialogId: string, message: string): Promise<string> {
    const url = `https://${this.domain}/rest/imbot.message.add`;

    const params: Record<string, string | number> = {
      DIALOG_ID: dialogId,
      MESSAGE: message,
      auth: this.accessToken,
    };

    if (this.botId !== undefined) {
      params.BOT_ID = this.botId;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(params),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (data.error) {
      throw new Error(`Bitrix error: ${data.error} — ${data.error_description}`);
    }

    return `Message sent successfully. Message ID: ${data.result}`;
  }
}
