import type { Command } from "commander";
import { resolve, basename } from "path";
import * as p from "@clack/prompts";
import { encryptEnvVars } from "../lib/crypto";
import {
  loadAppConfig,
  saveAppConfig,
  getConnection,
  apiHeaders,
  parseEnvFile,
} from "./config";
import { handleCancel, promptSelectServer, promptSelectGraph } from "./prompts";
import { registerEnvCommands } from "./env";
import { registerChannelCommands } from "./channels";
import { registerChatCommands } from "./chat";

export function registerClientCommands(program: Command) {
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
      } catch (err) {
        console.log("Status: unreachable");
        console.log(`  Error: ${err instanceof Error ? err.message : err}`);
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

  registerEnvCommands(clientCmd);
  registerChannelCommands(clientCmd);
  registerChatCommands(clientCmd);
}
