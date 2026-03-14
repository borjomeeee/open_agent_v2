import { resolve } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import dotenv from "dotenv";

const CONFIG_DIR = resolve(homedir(), ".openagent");
const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

export interface ServerProfile {
  url: string;
  key?: string;
  encryptionKey?: string;
}

export interface ServerConfig {
  port: number;
  dataDir: string;
}

export interface AppConfig {
  servers: Record<string, ServerProfile>;
  active?: string;
  serverConfig?: ServerConfig;
}

export async function loadAppConfig(): Promise<AppConfig> {
  const file = Bun.file(CONFIG_PATH);
  if (await file.exists()) {
    const raw = await file.json();
    if (raw.servers) return raw as AppConfig;
    if (raw.url) {
      return { servers: { default: { url: raw.url, key: raw.key } }, active: "default" };
    }
  }
  return { servers: {} };
}

export async function saveAppConfig(config: AppConfig) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export async function getActiveServer(): Promise<ServerProfile | null> {
  const config = await loadAppConfig();
  if (!config.active || !config.servers[config.active]) return null;
  return config.servers[config.active]!;
}

export async function getConnection(opts: {
  server?: string;
  key?: string;
}): Promise<ServerProfile> {
  if (opts.server) {
    return { url: opts.server.replace(/\/$/, ""), key: opts.key };
  }
  const server = await getActiveServer();
  if (!server) {
    console.error(
      "No active server. Run `openagent client setup` and `openagent client connect` first, or pass --server.",
    );
    process.exit(1);
  }
  if (opts.key) server.key = opts.key;
  return server;
}

export function apiHeaders(key?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) headers["X-API-Key"] = key;
  return headers;
}

export async function parseEnvFile(envPath: string): Promise<Record<string, string>> {
  const file = Bun.file(envPath);
  if (!(await file.exists())) {
    console.error(`Env file not found: ${envPath}`);
    process.exit(1);
  }
  const parsed: Record<string, string> = {};
  dotenv.config({ path: envPath, processEnv: parsed });
  return parsed;
}
