import type { Command } from "commander";
import * as readline from "readline";
import { getConnection, apiHeaders } from "./config";
import { promptSelectGraph } from "./prompts";

function formatResult(result: any): string {
  if (result === null || result === undefined) return "(no response)";

  if (result?.cliOutput) return result.cliOutput;

  // LangGraph messages state — extract last AI message
  if (result?.messages && Array.isArray(result.messages) && result.messages.length > 0) {
    const last = result.messages[result.messages.length - 1];
    const content = last?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) => (typeof c === "string" ? c : (c?.text ?? JSON.stringify(c))))
        .join("");
    }
  }

  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

export function registerChatCommands(clientCmd: Command) {
  clientCmd
    .command("chat [name]")
    .description("Start an interactive chat session with a graph")
    .option("-t, --thread-id <id>", "Thread ID for conversation memory (auto-generated if omitted)")
    .option("-s, --server <url>", "Server URL (overrides saved config)")
    .option("-k, --key <key>", "API key")
    .action(async (nameArg: string | undefined, opts) => {
      const conn = await getConnection(opts);
      const graphName = nameArg ?? (await promptSelectGraph(conn, "active"));
      const threadId: string = opts.threadId ?? crypto.randomUUID();

      console.log();
      console.log(`  \x1b[1mGraph\x1b[0m   ${graphName}`);
      console.log(`  \x1b[1mThread\x1b[0m  ${threadId}`);
      console.log(`  \x1b[2mType /exit or press Ctrl+C to end session\x1b[0m`);
      console.log();

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      rl.on("SIGINT", () => {
        console.log("\n\n  Session ended.");
        rl.close();
        process.exit(0);
      });

      const askLine = (): Promise<string | null> =>
        new Promise((resolve) => {
          rl.once("close", () => resolve(null));
          rl.question("\x1b[36mYou  \x1b[0m> ", resolve);
        });

      while (true) {
        const line = await askLine();
        if (line === null) break;

        const text = line.trim();
        if (!text || text === "/exit") break;

        process.stdout.write("\x1b[2mThinking...\x1b[0m");

        try {
          const res = await fetch(`${conn.url}/api/graphs/${graphName}/run`, {
            method: "POST",
            headers: { ...apiHeaders(conn.key), "Content-Type": "application/json" },
            body: JSON.stringify({ input: text, thread_id: threadId }),
          });

          process.stdout.write("\r\x1b[K"); // clear "Thinking..."

          const body = (await res.json()) as any;

          if (!res.ok) {
            console.log(`\x1b[31mError\x1b[0m  > ${body.error ?? res.statusText}\n`);
            continue;
          }

          const reply = formatResult(body.result);
          console.log(`\x1b[32mAgent\x1b[0m  > ${reply.replace(/\n/g, "\n         ")}\n`);
        } catch (err: any) {
          process.stdout.write("\r\x1b[K");
          console.log(`\x1b[31mError\x1b[0m  > ${err.message}\n`);
        }
      }

      console.log("  Session ended.");
      rl.close();
      process.exit(0);
    });
}
