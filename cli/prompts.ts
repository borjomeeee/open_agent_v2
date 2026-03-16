import * as p from "@clack/prompts";
import { readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import type { ServerProfile, AppConfig } from "./config.ts";
import { apiHeaders } from "./config.ts";

const HIDDEN_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".turbo", ".cache"]);

/**
 * Interactive file browser. Navigates directories with arrow keys and picks a file.
 * @param message  Prompt label shown to the user
 * @param opts.allowedExtensions  If provided, only files with these extensions are shown (dirs always shown)
 * @param opts.startDir  Starting directory (defaults to cwd)
 */
export async function promptFilePick(
  message: string,
  opts?: { allowedExtensions?: string[]; startDir?: string },
): Promise<string> {
  let dir = resolve(opts?.startDir ?? process.cwd());

  while (true) {
    const dirs: string[] = [];
    const files: string[] = [];

    try {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        try {
          if (statSync(full).isDirectory()) {
            if (!HIDDEN_DIRS.has(name)) dirs.push(name);
          } else {
            const exts = opts?.allowedExtensions;
            if (!exts?.length || exts.some((e) => name.endsWith(e))) {
              files.push(name);
            }
          }
        } catch {
          // skip unreadable entries
        }
      }
    } catch {
      // unreadable dir – show empty list and let user go up
    }

    const selected = await p.select({
      message: `${message}\n  > ${dir}`,
      options: [
        { value: "\0up", label: "../", hint: "go to parent directory" },
        ...dirs.map((d) => ({ value: `\0dir:${d}`, label: `[${d}]`, hint: "directory" })),
        ...files.map((f) => ({ value: join(dir, f), label: f })),
        { value: "\0manual", label: "(type a path manually)", hint: "paste or type a full path" },
      ],
    });

    handleCancel(selected);

    if (selected === "\0up") {
      dir = resolve(dir, "..");
    } else if (typeof selected === "string" && selected.startsWith("\0dir:")) {
      dir = join(dir, selected.slice(5));
    } else if (selected === "\0manual") {
      const manual = await p.text({
        message: "Enter the full file path",
        placeholder: "/path/to/file",
        validate: (v) => (!v ? "Path is required" : undefined),
      });
      handleCancel(manual);
      return resolve(manual);
    } else {
      return selected as string;
    }
  }
}

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
