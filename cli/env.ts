import type { Command } from "commander";
import { resolve } from "path";
import * as p from "@clack/prompts";
import { encryptEnvVars } from "../lib/crypto.ts";
import { getConnection, apiHeaders, parseEnvFile, type ServerProfile } from "./config.ts";
import { handleCancel, promptSelectGraph } from "./prompts.ts";

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

export function registerEnvCommands(clientCmd: Command) {
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
}
