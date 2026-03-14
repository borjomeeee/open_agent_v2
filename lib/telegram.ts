export class TelegramService {
  constructor(private botToken: string) {}

  async sendMessage(chatId: number, message: string): Promise<any> {
    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to send Telegram message: ${res.statusText}`);
    }

    return res.json();
  }
}
