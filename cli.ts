#!/usr/bin/env bun

import { Command } from "commander";
import { resolve, basename, dirname } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import dotenv from "dotenv";
import { encryptEnvVars } from "./lib/crypto.ts";
import * as p from "@clack/prompts";

const program = new Command();

program
  .name("openagent")
  .description("CLI for serving and deploying LangGraph workflows")
  .version("0.1.0");

// ─── Config helpers ────────────────────────────────────────────────

const CONFIG_DIR = resolve(homedir(), ".openagent");
const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");

interface ServerProfile {
  url: string;
  key?: string;
  encryptionKey?: string;
}

interface ServerConfig {
  port: number;
  dataDir: string;
}

interface AppConfig {
  servers: Record<string, ServerProfile>;
  active?: string;
  serverConfig?: ServerConfig;
}

async function loadAppConfig(): Promise<AppConfig> {
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

async function saveAppConfig(config: AppConfig) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function getActiveServer(): Promise<ServerProfile | null> {
  const config = await loadAppConfig();
  if (!config.active || !config.servers[config.active]) return null;
  return config.servers[config.active]!;
}

async function getConnection(opts: {
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

function apiHeaders(key?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) headers["X-API-Key"] = key;
  return headers;
}

// ─── Interactive prompt helpers ────────────────────────────────────

function handleCancel<T>(value: T): asserts value is Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
}

async function fetchGraphList(conn: ServerProfile): Promise<any[]> {
  const res = await fetch(`${conn.url}/api/graphs`, {
    headers: apiHeaders(conn.key),
  });
  if (!res.ok) {
    console.error(`Failed to fetch graphs: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const { graphs } = (await res.json()) as { graphs: any[] };
  return graphs;
}

async function promptSelectServer(config: AppConfig): Promise<string> {
  const names = Object.keys(config.servers);
  if (names.length === 0) {
    console.error("No servers configured. Run `openagent client setup` first.");
    process.exit(1);
  }
  const name = await p.select({
    message: "Select a server profile",
    options: names.map((n) => ({
      value: n,
      label: n,
      hint: `${config.servers[n]!.url}${n === config.active ? " (active)" : ""}`,
    })),
  });
  handleCancel(name);
  return name;
}

async function promptSelectGraph(conn: ServerProfile, filter?: "active" | "all"): Promise<string> {
  let graphs = await fetchGraphList(conn);
  if (filter === "active") {
    graphs = graphs.filter((g: any) => g.active);
  }
  if (graphs.length === 0) {
    console.error(filter === "active" ? "No active graphs found." : "No graphs deployed.");
    process.exit(1);
  }
  const name = await p.select({
    message: "Select a graph",
    options: graphs.map((g: any) => ({
      value: g.name as string,
      label: g.name,
      hint: g.active ? "active" : "inactive",
    })),
  });
  handleCancel(name);
  return name;
}

// ─── openagent server ──────────────────────────────────────────────

const serverCmd = program.command("server").description("Server management");

serverCmd
  .command("start")
  .description("Start the openagent server")
  .option("-p, --port <port>", "Port to listen on")
  .option("-d, --data-dir <dir>", "Directory for deployed graphs")
  .option("--foreground", "Run in foreground (don't daemonize)")
  .action(async (opts) => {
    const config = await loadAppConfig();
    const saved = config.serverConfig;

    const port = parseInt(opts.port || "") || saved?.port || 3000;
    const dataDir = resolve(opts.dataDir || saved?.dataDir || "./deployed");

    if (!saved && !opts.port && !opts.dataDir && !opts.foreground) {
      console.log(`Using defaults (port: ${port}, data-dir: ${dataDir}). Run \`openagent server setup\` to configure.`);
    }

    if (!opts.foreground) {
      const args = [
        "bun",
        import.meta.path,
        "server",
        "start",
        "--foreground",
        "--port",
        String(port),
        "--data-dir",
        dataDir,
      ];

      const proc = Bun.spawn(args, {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });

      const pidPath = resolve("openagent.pid");
      await Bun.write(pidPath, String(proc.pid));

      console.log(`openagent server started (pid: ${proc.pid})`);
      console.log(`  port:     ${port}`);
      console.log(`  data-dir: ${dataDir}`);
      console.log(`  pid file: ${pidPath}`);
      proc.unref();
      process.exit(0);
    }

    const { createServer } = await import("./server/index.ts");
    const app = await createServer(dataDir);

    console.log(`openagent server listening on port ${port}`);
    console.log(`  data-dir: ${dataDir}`);

    Bun.serve({
      port,
      fetch: app.fetch,
    });
  });

serverCmd
  .command("stop")
  .description("Stop the running openagent server")
  .action(async () => {
    const pidPath = resolve("openagent.pid");
    const pidFile = Bun.file(pidPath);

    if (!(await pidFile.exists())) {
      console.error("No PID file found. Is the server running?");
      process.exit(1);
    }

    const pid = parseInt(await pidFile.text());

    try {
      process.kill(pid, "SIGTERM");
      console.log(`Sent SIGTERM to process ${pid}`);
      const { unlink } = await import("fs/promises");
      await unlink(pidPath);
    } catch (err: any) {
      if (err.code === "ESRCH") {
        console.log(`Process ${pid} is not running. Cleaning up PID file.`);
        const { unlink } = await import("fs/promises");
        await unlink(pidPath);
      } else {
        console.error(`Failed to stop server: ${err.message}`);
        process.exit(1);
      }
    }
  });

serverCmd
  .command("status")
  .description("Check server status")
  .action(async () => {
    const pidPath = resolve("openagent.pid");
    const pidFile = Bun.file(pidPath);

    if (!(await pidFile.exists())) {
      console.log("Server is not running (no PID file)");
      return;
    }

    const pid = parseInt(await pidFile.text());

    try {
      process.kill(pid, 0);
      console.log(`Server is running (pid: ${pid})`);
    } catch {
      console.log(`Server is not running (stale PID file, pid was: ${pid})`);
    }
  });

serverCmd
  .command("setup")
  .description("Configure default server settings (port, data directory)")
  .option("-p, --port <port>", "Port to listen on")
  .option("-d, --data-dir <dir>", "Directory for deployed graphs")
  .action(async (opts) => {
    const config = await loadAppConfig();
    const existing = config.serverConfig;

    let port: number;
    let dataDir: string;

    if (opts.port && opts.dataDir) {
      port = parseInt(opts.port);
      dataDir = resolve(opts.dataDir);
    } else {
      p.intro("Server configuration");

      const answers = await p.group({
        port: () =>
          p.text({
            message: "Port to listen on",
            placeholder: String(existing?.port ?? 3000),
            defaultValue: String(existing?.port ?? 3000),
            validate: (v) => (!v || isNaN(parseInt(v)) ? "Must be a number" : undefined),
          }),
        dataDir: () =>
          p.text({
            message: "Directory for deployed graphs",
            placeholder: existing?.dataDir ?? "./deployed",
            defaultValue: existing?.dataDir ?? "./deployed",
          }),
      }, {
        onCancel: () => { p.cancel("Operation cancelled."); process.exit(0); },
      });

      port = parseInt(answers.port);
      dataDir = resolve(answers.dataDir);
    }

    config.serverConfig = { port, dataDir };
    await saveAppConfig(config);
    console.log(`Server config saved:`);
    console.log(`  port:     ${port}`);
    console.log(`  data-dir: ${dataDir}`);
  });

// ─── openagent client ──────────────────────────────────────────────

const clientCmd = program.command("client").description("Client operations");

clientCmd
  .command("setup [name] [url]")
  .description("Add or update a named server profile")
  .option("-k, --key <key>", "API key for authentication")
  .option("--encryption-key <encryptionKey>", "Shared secret for encrypting env vars in transit")
  .action(async (nameArg: string | undefined, urlArg: string | undefined, opts) => {
    let name = nameArg;
    let url = urlArg;
    let key = opts.key as string | undefined;
    let encryptionKey = opts.encryptionKey as string | undefined;

    if (!name || !url) {
      p.intro("Server profile setup");

      const answers = await p.group({
        name: () =>
          p.text({
            message: "Profile name",
            placeholder: "default",
            defaultValue: name || "default",
            validate: (v) => (!v ? "Name is required" : undefined),
          }),
        url: () =>
          p.text({
            message: "Server URL",
            placeholder: "http://localhost:3000",
            initialValue: url,
            validate: (v) => (!v ? "URL is required" : undefined),
          }),
        key: () =>
          p.password({
            message: "API key (leave empty to skip)",
          }),
        encryptionKey: () =>
          p.password({
            message: "Encryption key for env vars (leave empty to skip)",
          }),
      }, {
        onCancel: () => { p.cancel("Operation cancelled."); process.exit(0); },
      });

      name = answers.name;
      url = answers.url;
      if (answers.key) key = answers.key;
      if (answers.encryptionKey) encryptionKey = answers.encryptionKey;
    }

    const config = await loadAppConfig();

    config.servers[name] = {
      url: url.replace(/\/$/, ""),
      key,
      encryptionKey,
    };

    const isFirst = Object.keys(config.servers).length === 1;
    if (isFirst) config.active = name;

    await saveAppConfig(config);

    console.log(`Server '${name}' saved (${config.servers[name]!.url})`);
    if (isFirst) {
      console.log(`Automatically set as active connection.`);
    }

    try {
      const res = await fetch(`${config.servers[name]!.url}/health`);
      if (res.ok) {
        console.log("Server is reachable.");
      } else {
        console.warn(`Server responded with status ${res.status}`);
      }
    } catch {
      console.warn("Could not reach server right now.");
    }
  });

clientCmd
  .command("connect [name]")
  .description("Switch the active server connection")
  .action(async (nameArg: string | undefined) => {
    const config = await loadAppConfig();
    let name = nameArg;

    if (!name) {
      name = await promptSelectServer(config);
    }

    if (!config.servers[name]) {
      console.error(`Server '${name}' not found. Available servers:`);
      const names = Object.keys(config.servers);
      if (names.length === 0) {
        console.error("  (none) -- run `openagent client setup` first");
      } else {
        for (const n of names) {
          console.error(`  - ${n} (${config.servers[n]!.url})`);
        }
      }
      process.exit(1);
    }

    config.active = name;
    await saveAppConfig(config);

    const server = config.servers[name]!;
    console.log(`Active server: ${name} (${server.url})`);

    try {
      const res = await fetch(`${server.url}/health`, {
        headers: apiHeaders(server.key),
      });
      if (res.ok) {
        console.log("Server is reachable.");
      } else {
        console.warn(`Server responded with status ${res.status}`);
      }
    } catch {
      console.warn("Could not reach server right now.");
    }
  });

clientCmd
  .command("status")
  .description("Show all servers and check active connection")
  .action(async () => {
    const config = await loadAppConfig();
    const names = Object.keys(config.servers);

    if (names.length === 0) {
      console.log("No servers configured. Run `openagent client setup` to add one.");
      return;
    }

    console.log(`\nServers:`);
    for (const name of names) {
      const s = config.servers[name]!;
      const marker = name === config.active ? " *" : "  ";
      const keyStatus = s.key ? "key set" : "no key";
      console.log(`${marker} ${name.padEnd(15)} ${s.url.padEnd(35)} (${keyStatus})`);
    }

    if (!config.active) {
      console.log("\nNo active connection. Run `openagent client connect` to select one.");
      return;
    }

    const active = config.servers[config.active]!;
    console.log(`\nActive: ${config.active}`);

    try {
      const res = await fetch(`${active.url}/health`, {
        headers: apiHeaders(active.key),
      });
      if (res.ok) {
        console.log("Status: reachable");

        const graphsRes = await fetch(`${active.url}/api/graphs`, {
          headers: apiHeaders(active.key),
        });
        if (graphsRes.ok) {
          const { graphs } = (await graphsRes.json()) as { graphs: any[] };
          const activeCount = graphs.filter((g: any) => g.active).length;
          console.log(`Graphs: ${graphs.length} deployed, ${activeCount} active`);
        }
      } else {
        console.log(`Status: server responded with ${res.status}`);
      }
    } catch {
      console.log("Status: unreachable");
    }
    console.log();
  });

clientCmd
  .command("graphs")
  .description("List deployed graphs")
  .option("-s, --server <url>", "Server URL (overrides saved config)")
  .option("-k, --key <key>", "API key")
  .action(async (opts) => {
    const conn = await getConnection(opts);
    const res = await fetch(`${conn.url}/api/graphs`, {
      headers: apiHeaders(conn.key),
    });

    if (!res.ok) {
      console.error(`Error: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const { graphs } = (await res.json()) as { graphs: any[] };

    if (graphs.length === 0) {
      console.log("No graphs deployed.");
      return;
    }

    console.log(`\n  ${"Name".padEnd(20)} ${"Status".padEnd(10)} ${"Deployed At".padEnd(25)} Exports`);
    console.log(`  ${"─".repeat(20)} ${"─".repeat(10)} ${"─".repeat(25)} ${"─".repeat(20)}`);

    for (const g of graphs) {
      const status = g.active ? "active" : "inactive";
      const date = new Date(g.deployedAt).toLocaleString();
      const exports = g.exports?.join(", ") || "-";
      console.log(`  ${g.name.padEnd(20)} ${status.padEnd(10)} ${date.padEnd(25)} ${exports}`);
    }
    console.log();
  });

clientCmd
  .command("start [fileOrName]")
  .description(
    "Deploy and activate a graph (pass .ts file) or activate an existing one (pass name)",
  )
  .option("-n, --name <name>", "Graph name (defaults to filename without extension)")
  .option("-e, --env <path>", "Path to .env file with graph-specific variables")
  .option("-s, --server <url>", "Server URL (overrides saved config)")
  .option("-k, --key <key>", "API key")
  .action(async (fileOrNameArg: string | undefined, opts) => {
    let fileOrName = fileOrNameArg;

    if (!fileOrName) {
      const mode = await p.select({
        message: "What would you like to do?",
        options: [
          { value: "deploy" as const, label: "Deploy a file", hint: "bundle and deploy a .ts/.js file" },
          { value: "activate" as const, label: "Activate an existing graph", hint: "start a previously deployed graph" },
        ],
      });
      handleCancel(mode);

      if (mode === "deploy") {
        const filePath = await p.text({
          message: "Path to the graph file (.ts or .js)",
          placeholder: "./workflows/my-graph.ts",
          validate: (v) => {
            if (!v) return "File path is required";
            if (!v.endsWith(".ts") && !v.endsWith(".js")) return "File must be .ts or .js";
            return undefined;
          },
        });
        handleCancel(filePath);
        fileOrName = filePath;

        if (!opts.name) {
          const nameOverride = await p.text({
            message: "Graph name (leave empty to use filename)",
            placeholder: basename(filePath).replace(/\.(ts|js)$/, ""),
          });
          handleCancel(nameOverride);
          if (nameOverride) opts.name = nameOverride;
        }

        if (!opts.env) {
          const wantEnv = await p.confirm({
            message: "Include a .env file?",
            initialValue: false,
          });
          handleCancel(wantEnv);
          if (wantEnv) {
            const envPath = await p.text({
              message: "Path to .env file",
              placeholder: "./.env",
              validate: (v) => (!v ? "Path is required" : undefined),
            });
            handleCancel(envPath);
            opts.env = envPath;
          }
        }
      } else {
        const conn = await getConnection(opts);
        fileOrName = await promptSelectGraph(conn, "all");
      }
    }

    const conn = await getConnection(opts);
    const isFile = fileOrName!.endsWith(".ts") || fileOrName!.endsWith(".js");

    if (isFile) {
      const filePath = resolve(fileOrName!);
      const graphName =
        opts.name || basename(filePath).replace(/\.(ts|js)$/, "");

      let envVars: Record<string, string> | undefined;
      if (opts.env) {
        const envPath = resolve(opts.env);
        envVars = await parseEnvFile(envPath);
        if (Object.keys(envVars).length === 0) {
          envVars = undefined;
        }
      }

      console.log(`Bundling ${filePath}...`);

      const result = await Bun.build({
        entrypoints: [filePath],
        target: "bun",
        format: "esm",
        external: [
          "@langchain/*",
          "langchain",
          "zod",
        ],
      });

      if (!result.success) {
        console.error("Bundle failed:");
        for (const log of result.logs) {
          console.error(`  ${log}`);
        }
        process.exit(1);
      }

      const bundledCode = await result.outputs[0]!.text();
      console.log(
        `Bundle complete (${(bundledCode.length / 1024).toFixed(1)} KB)`,
      );

      const deployBody: Record<string, any> = { name: graphName, code: bundledCode };
      const headers = apiHeaders(conn.key);

      if (envVars) {
        const encrypted = !!conn.encryptionKey;
        console.log(`Including ${Object.keys(envVars).length} env var(s)${encrypted ? " (encrypted)" : ""} in deploy...`);
        if (conn.encryptionKey) {
          deployBody.env = encryptEnvVars(envVars, conn.encryptionKey);
          headers["X-Env-Encrypted"] = "true";
        } else {
          deployBody.env = envVars;
        }
      }

      console.log(`Deploying as '${graphName}'...`);
      const res = await fetch(`${conn.url}/api/graphs/deploy`, {
        method: "POST",
        headers,
        body: JSON.stringify(deployBody),
      });

      const body = await res.json();
      if (!res.ok) {
        console.error(`Deploy failed: ${(body as any).error}`);
        process.exit(1);
      }

      console.log((body as any).message);
      if ((body as any).exports) {
        console.log(`  exports: ${(body as any).exports.join(", ")}`);
      }
    } else {
      console.log(`Activating graph '${fileOrName!}'...`);
      const res = await fetch(`${conn.url}/api/graphs/${fileOrName!}/start`, {
        method: "POST",
        headers: apiHeaders(conn.key),
      });

      const body = await res.json();
      if (!res.ok) {
        console.error(`Failed: ${(body as any).error}`);
        process.exit(1);
      }
      console.log((body as any).message);
    }
  });

clientCmd
  .command("stop [name]")
  .description("Deactivate a graph (keeps file, disables webhook)")
  .option("-s, --server <url>", "Server URL (overrides saved config)")
  .option("-k, --key <key>", "API key")
  .action(async (nameArg: string | undefined, opts) => {
    const conn = await getConnection(opts);
    const name = nameArg || await promptSelectGraph(conn, "active");

    const res = await fetch(`${conn.url}/api/graphs/${name}/stop`, {
      method: "POST",
      headers: apiHeaders(conn.key),
    });

    const body = await res.json();
    if (!res.ok) {
      console.error(`Failed: ${(body as any).error}`);
      process.exit(1);
    }
    console.log((body as any).message);
  });

clientCmd
  .command("remove [name]")
  .description("Fully remove a deployed graph (deletes file)")
  .option("-s, --server <url>", "Server URL (overrides saved config)")
  .option("-k, --key <key>", "API key")
  .action(async (nameArg: string | undefined, opts) => {
    const conn = await getConnection(opts);
    const name = nameArg || await promptSelectGraph(conn, "all");

    if (!nameArg) {
      const confirmed = await p.confirm({
        message: `Remove graph '${name}'? This will delete the deployed file.`,
        initialValue: false,
      });
      handleCancel(confirmed);
      if (!confirmed) {
        p.cancel("Removal cancelled.");
        process.exit(0);
      }
    }

    const res = await fetch(`${conn.url}/api/graphs/${name}`, {
      method: "DELETE",
      headers: apiHeaders(conn.key),
    });

    const body = await res.json();
    if (!res.ok) {
      console.error(`Failed: ${(body as any).error}`);
      process.exit(1);
    }
    console.log((body as any).message);
  });

// ─── Env helpers ──────────────────────────────────────────────────

async function parseEnvFile(envPath: string): Promise<Record<string, string>> {
  const file = Bun.file(envPath);
  if (!(await file.exists())) {
    console.error(`Env file not found: ${envPath}`);
    process.exit(1);
  }
  const parsed: Record<string, string> = {};
  dotenv.config({ path: envPath, processEnv: parsed });
  return parsed;
}

function prepareEnvPayload(
  vars: Record<string, string>,
  conn: ServerProfile,
): { headers: Record<string, string>; body: string } {
  const headers = apiHeaders(conn.key);
  let payload = vars;
  if (conn.encryptionKey) {
    payload = encryptEnvVars(vars, conn.encryptionKey);
    headers["X-Env-Encrypted"] = "true";
  }
  return { headers, body: JSON.stringify({ vars: payload }) };
}

// ─── openagent client env ─────────────────────────────────────────

const envCmd = clientCmd.command("env").description("Manage per-graph environment variables");

envCmd
  .command("set [name] [vars...]")
  .description("Set env vars for a graph (replaces all existing, KEY=VALUE pairs or .env file)")
  .option("-s, --server <url>", "Server URL")
  .option("-k, --key <key>", "API key")
  .action(async (nameArg: string | undefined, vars: string[], opts) => {
    const conn = await getConnection(opts);
    const name = nameArg || await promptSelectGraph(conn, "all");

    const parsed: Record<string, string> = {};

    if (vars.length === 0) {
      const source = await p.select({
        message: "How would you like to provide env vars?",
        options: [
          { value: "manual" as const, label: "Enter KEY=VALUE pairs one by one" },
          { value: "file" as const, label: "Load from a .env file" },
        ],
      });
      handleCancel(source);

      if (source === "file") {
        const envPath = await p.text({
          message: "Path to .env file",
          placeholder: "./.env",
          validate: (v) => (!v ? "Path is required" : undefined),
        });
        handleCancel(envPath);
        const fileVars = await parseEnvFile(resolve(envPath));
        Object.assign(parsed, fileVars);
      } else {
        let adding = true;
        while (adding) {
          const pair = await p.text({
            message: "Enter KEY=VALUE (leave empty to finish)",
            placeholder: "MY_API_KEY=sk-...",
          });
          handleCancel(pair);
          if (!pair) {
            adding = false;
            break;
          }
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) {
            console.warn(`Skipped '${pair}' -- expected KEY=VALUE format.`);
            continue;
          }
          parsed[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }

      if (Object.keys(parsed).length === 0) {
        console.log("No env vars provided.");
        return;
      }
    } else {
      for (const v of vars) {
        const eqIdx = v.indexOf("=");
        if (eqIdx === -1) {
          console.error(`Invalid format: '${v}'. Use KEY=VALUE.`);
          process.exit(1);
        }
        parsed[v.slice(0, eqIdx)] = v.slice(eqIdx + 1);
      }
    }

    const { headers, body } = prepareEnvPayload(parsed, conn);
    const res = await fetch(`${conn.url}/api/graphs/${name}/env`, {
      method: "PUT",
      headers,
      body,
    });

    const resBody = await res.json();
    if (!res.ok) {
      console.error(`Failed: ${(resBody as any).error}`);
      process.exit(1);
    }
    console.log((resBody as any).message);
  });

envCmd
  .command("list [name]")
  .description("List env vars for a graph (values masked)")
  .option("-s, --server <url>", "Server URL")
  .option("-k, --key <key>", "API key")
  .action(async (nameArg: string | undefined, opts) => {
    const conn = await getConnection(opts);
    const name = nameArg || await promptSelectGraph(conn, "all");
    const res = await fetch(`${conn.url}/api/graphs/${name}/env`, {
      headers: apiHeaders(conn.key),
    });

    if (!res.ok) {
      const body = await res.json();
      console.error(`Failed: ${(body as any).error}`);
      process.exit(1);
    }

    const { env } = (await res.json()) as { env: Record<string, string> };
    const keys = Object.keys(env);
    if (keys.length === 0) {
      console.log(`No env vars set for '${name}'.`);
      return;
    }

    console.log(`\nEnv vars for '${name}':`);
    for (const [key, value] of Object.entries(env)) {
      console.log(`  ${key}=${value}`);
    }
    console.log();
  });

// ─── openagent client channels ────────────────────────────────────

const channelsCmd = clientCmd.command("channels").description("Manage channels (triggers for graphs)");

channelsCmd
  .command("list")
  .description("List all channels")
  .option("-g, --graph <name>", "Filter by graph name")
  .option("-s, --server <url>", "Server URL")
  .option("-k, --key <key>", "API key")
  .action(async (opts) => {
    const conn = await getConnection(opts);
    const url = opts.graph
      ? `${conn.url}/api/channels?graph=${encodeURIComponent(opts.graph)}`
      : `${conn.url}/api/channels`;

    const res = await fetch(url, { headers: apiHeaders(conn.key) });
    if (!res.ok) {
      console.error(`Error: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const { channels } = (await res.json()) as { channels: any[] };
    if (channels.length === 0) {
      console.log("No channels configured.");
      return;
    }

    console.log(`\n  ${"ID".padEnd(38)} ${"Type".padEnd(12)} ${"Graph".padEnd(20)} ${"Status".padEnd(10)}`);
    console.log(`  ${"─".repeat(38)} ${"─".repeat(12)} ${"─".repeat(20)} ${"─".repeat(10)}`);

    for (const ch of channels) {
      const status = ch.active ? "active" : "inactive";
      console.log(`  ${ch.id.padEnd(38)} ${ch.type.padEnd(12)} ${ch.graphName.padEnd(20)} ${status.padEnd(10)}`);
    }
    console.log();
  });

channelsCmd
  .command("add")
  .description("Create a new channel")
  .option("-s, --server <url>", "Server URL")
  .option("-k, --key <key>", "API key")
  .action(async (opts) => {
    const conn = await getConnection(opts);

    const type = await p.select({
      message: "Channel type",
      options: [
        { value: "webhook" as const, label: "Webhook", hint: "HTTP endpoint that invokes a graph" },
        { value: "telegram" as const, label: "Telegram", hint: "Telegram bot webhook" },
        { value: "cron" as const, label: "Cron", hint: "Scheduled graph invocation" },
        { value: "graph" as const, label: "Graph", hint: "Triggered when another graph completes" },
      ],
    });
    handleCancel(type);

    const graphName = await promptSelectGraph(conn, "all");

    let config: Record<string, any> = {};

    if (type === "webhook") {
      const secret = await p.text({
        message: "HMAC secret for signature verification (leave empty to skip)",
        placeholder: "optional",
      });
      handleCancel(secret);
      if (secret) config.secret = secret;
    } else if (type === "telegram") {
      const botToken = await p.text({
        message: "Telegram bot token",
        validate: (v) => (!v ? "Bot token is required" : undefined),
      });
      handleCancel(botToken);
      config.botToken = botToken;
    } else if (type === "cron") {
      const schedule = await p.text({
        message: "Cron schedule expression",
        placeholder: "*/5 * * * *",
        validate: (v) => (!v ? "Schedule is required" : undefined),
      });
      handleCancel(schedule);
      config.schedule = schedule;

      const inputStr = await p.text({
        message: "Static input JSON for the graph",
        placeholder: '{"key": "value"}',
        defaultValue: "{}",
        validate: (v) => {
          try { JSON.parse(v || "{}"); return undefined; }
          catch { return "Must be valid JSON"; }
        },
      });
      handleCancel(inputStr);
      config.input = JSON.parse(inputStr || "{}");
    } else if (type === "graph") {
      const sourceGraph = await p.text({
        message: "Source graph name (triggers when this graph completes)",
        validate: (v) => (!v ? "Source graph name is required" : undefined),
      });
      handleCancel(sourceGraph);
      config.sourceGraph = sourceGraph;
    }

    const res = await fetch(`${conn.url}/api/channels`, {
      method: "POST",
      headers: apiHeaders(conn.key),
      body: JSON.stringify({ type, graphName, config }),
    });

    const body = await res.json();
    if (!res.ok) {
      console.error(`Failed: ${(body as any).error}`);
      process.exit(1);
    }

    console.log((body as any).message);
    console.log(`  ID: ${(body as any).channel.id}`);
    console.log(`  Type: ${type}`);
    console.log(`  Graph: ${graphName}`);

    const shouldStart = await p.confirm({
      message: "Activate this channel now?",
      initialValue: true,
    });
    handleCancel(shouldStart);

    if (shouldStart) {
      const startRes = await fetch(`${conn.url}/api/channels/${(body as any).channel.id}/start`, {
        method: "POST",
        headers: apiHeaders(conn.key),
      });
      const startBody = await startRes.json();
      if (startRes.ok) {
        console.log((startBody as any).message);
      } else {
        console.error(`Activation failed: ${(startBody as any).error}`);
      }
    }
  });

channelsCmd
  .command("remove [id]")
  .description("Remove a channel")
  .option("-s, --server <url>", "Server URL")
  .option("-k, --key <key>", "API key")
  .action(async (idArg: string | undefined, opts) => {
    const conn = await getConnection(opts);
    const id = idArg || await promptSelectChannel(conn);

    const confirmed = await p.confirm({
      message: `Remove channel '${id}'?`,
      initialValue: false,
    });
    handleCancel(confirmed);
    if (!confirmed) {
      p.cancel("Removal cancelled.");
      process.exit(0);
    }

    const res = await fetch(`${conn.url}/api/channels/${id}`, {
      method: "DELETE",
      headers: apiHeaders(conn.key),
    });

    const body = await res.json();
    if (!res.ok) {
      console.error(`Failed: ${(body as any).error}`);
      process.exit(1);
    }
    console.log((body as any).message);
  });

channelsCmd
  .command("start [id]")
  .description("Activate a channel")
  .option("-s, --server <url>", "Server URL")
  .option("-k, --key <key>", "API key")
  .action(async (idArg: string | undefined, opts) => {
    const conn = await getConnection(opts);
    const id = idArg || await promptSelectChannel(conn, "inactive");

    const res = await fetch(`${conn.url}/api/channels/${id}/start`, {
      method: "POST",
      headers: apiHeaders(conn.key),
    });

    const body = await res.json();
    if (!res.ok) {
      console.error(`Failed: ${(body as any).error}`);
      process.exit(1);
    }
    console.log((body as any).message);
  });

channelsCmd
  .command("stop [id]")
  .description("Deactivate a channel")
  .option("-s, --server <url>", "Server URL")
  .option("-k, --key <key>", "API key")
  .action(async (idArg: string | undefined, opts) => {
    const conn = await getConnection(opts);
    const id = idArg || await promptSelectChannel(conn, "active");

    const res = await fetch(`${conn.url}/api/channels/${id}/stop`, {
      method: "POST",
      headers: apiHeaders(conn.key),
    });

    const body = await res.json();
    if (!res.ok) {
      console.error(`Failed: ${(body as any).error}`);
      process.exit(1);
    }
    console.log((body as any).message);
  });

async function promptSelectChannel(conn: ServerProfile, filter?: "active" | "inactive"): Promise<string> {
  const res = await fetch(`${conn.url}/api/channels`, {
    headers: apiHeaders(conn.key),
  });
  if (!res.ok) {
    console.error(`Failed to fetch channels: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  let { channels } = (await res.json()) as { channels: any[] };
  if (filter === "active") channels = channels.filter((c: any) => c.active);
  if (filter === "inactive") channels = channels.filter((c: any) => !c.active);

  if (channels.length === 0) {
    console.error("No matching channels found.");
    process.exit(1);
  }

  const id = await p.select({
    message: "Select a channel",
    options: channels.map((c: any) => ({
      value: c.id as string,
      label: `${c.type} → ${c.graphName}`,
      hint: `${c.id.slice(0, 8)}... ${c.active ? "active" : "inactive"}`,
    })),
  });
  handleCancel(id);
  return id;
}

program.parse();
