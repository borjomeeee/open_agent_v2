import * as p from "@clack/prompts";
import type { ServerProfile, AppConfig } from "./config.ts";
import { apiHeaders } from "./config.ts";

export function handleCancel<T>(value: T): asserts value is Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
}

export async function fetchGraphList(conn: ServerProfile): Promise<any[]> {
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

export async function promptSelectServer(config: AppConfig): Promise<string> {
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

export async function promptSelectGraph(conn: ServerProfile, filter?: "active" | "all"): Promise<string> {
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
