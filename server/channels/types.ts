export type ChannelType = "webhook" | "telegram" | "cron" | "graph" | "bitrix";

export interface WebhookConfig {
  path?: string;
  secret?: string;
}

export interface TelegramConfig {
  botToken: string;
}

export interface CronConfig {
  schedule: string;
  input: Record<string, any>;
}

export interface GraphConfig {
  sourceGraph: string;
}

export interface BitrixConfig {
  secret?: string;
}

export type ChannelConfig = WebhookConfig | TelegramConfig | CronConfig | GraphConfig | BitrixConfig;

export interface Channel {
  id: string;
  type: ChannelType;
  graphName: string;
  config: ChannelConfig;
  active: boolean;
  createdAt: string;
}

export interface ChannelsData {
  channels: Record<string, Channel>;
}
