#!/usr/bin/env bun

import { Command } from "commander";
import { resolve, basename } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";

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
}

interface AppConfig {
  servers: Record<string, ServerProfile>;
  active?: string;
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

// ─── openagent server ──────────────────────────────────────────────

const serverCmd = program.command("server").description("Server management");

serverCmd
  .command("start")
  .description("Start the openagent server")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .option("-d, --data-dir <dir>", "Directory for deployed graphs", "./deployed")
  .option("--foreground", "Run in foreground (don't daemonize)")
  .action(async (opts) => {
    const port = parseInt(opts.port);
    const dataDir = resolve(opts.dataDir);

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

// ─── openagent client ──────────────────────────────────────────────

const clientCmd = program.command("client").description("Client operations");

clientCmd
  .command("setup <name> <url>")
  .description("Add or update a named server profile")
  .option("-k, --key <key>", "API key for authentication")
  .action(async (name: string, url: string, opts) => {
    const config = await loadAppConfig();

    config.servers[name] = {
      url: url.replace(/\/$/, ""),
      key: opts.key,
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
  .command("connect <name>")
  .description("Switch the active server connection")
  .action(async (name: string) => {
    const config = await loadAppConfig();

    if (!config.servers[name]) {
      console.error(`Server '${name}' not found. Available servers:`);
      const names = Object.keys(config.servers);
      if (names.length === 0) {
        console.error("  (none) -- run `openagent client setup <name> <url>` first");
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
      console.log("No servers configured. Run `openagent client setup <name> <url>` to add one.");
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
      console.log("\nNo active connection. Run `openagent client connect <name>`.");
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
  .command("start <fileOrName>")
  .description(
    "Deploy and activate a graph (pass .ts file) or activate an existing one (pass name)",
  )
  .option("-n, --name <name>", "Graph name (defaults to filename without extension)")
  .option("-s, --server <url>", "Server URL (overrides saved config)")
  .option("-k, --key <key>", "API key")
  .action(async (fileOrName: string, opts) => {
    const conn = await getConnection(opts);
    const isFile = fileOrName.endsWith(".ts") || fileOrName.endsWith(".js");

    if (isFile) {
      const filePath = resolve(fileOrName);
      const graphName =
        opts.name || basename(filePath).replace(/\.(ts|js)$/, "");

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

      console.log(`Deploying as '${graphName}'...`);
      const res = await fetch(`${conn.url}/api/graphs/deploy`, {
        method: "POST",
        headers: apiHeaders(conn.key),
        body: JSON.stringify({ name: graphName, code: bundledCode }),
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
      console.log(`Activating graph '${fileOrName}'...`);
      const res = await fetch(`${conn.url}/api/graphs/${fileOrName}/start`, {
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
  .command("stop <name>")
  .description("Deactivate a graph (keeps file, disables webhook)")
  .option("-s, --server <url>", "Server URL (overrides saved config)")
  .option("-k, --key <key>", "API key")
  .action(async (name: string, opts) => {
    const conn = await getConnection(opts);

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
  .command("remove <name>")
  .description("Fully remove a deployed graph (deletes file)")
  .option("-s, --server <url>", "Server URL (overrides saved config)")
  .option("-k, --key <key>", "API key")
  .action(async (name: string, opts) => {
    const conn = await getConnection(opts);

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

program.parse();
