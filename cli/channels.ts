import type { Command } from "commander";
import * as p from "@clack/prompts";
import { getConnection, apiHeaders, type ServerProfile } from "./config.ts";
import { handleCancel, promptSelectGraph } from "./prompts.ts";

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

export function registerChannelCommands(clientCmd: Command) {
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
}
