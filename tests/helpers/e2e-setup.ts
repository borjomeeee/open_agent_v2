import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Server } from "bun";
import { createServer } from "../../server/index.ts";

export interface E2EContext {
  baseUrl: string;
  server: Server<undefined>;
  dataDir: string;
  cleanup: () => Promise<void>;
}

let portCounter = 19_000 + Math.floor(Math.random() * 1000);

/**
 * Boots a real HTTP server on a random port.
 * Returns the base URL and a cleanup function that shuts everything down.
 */
export async function startE2EServer(opts?: { apiKey?: string }): Promise<E2EContext> {
  const dataDir = await mkdtemp(join(tmpdir(), "openagent-e2e-"));

  const origApiKey = process.env.API_KEY;
  if (opts?.apiKey) {
    process.env.API_KEY = opts.apiKey;
  } else {
    delete process.env.API_KEY;
  }

  const app = await createServer(dataDir);
  const port = portCounter++;

  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  const baseUrl = `http://localhost:${server.port}`;

  return {
    baseUrl,
    server,
    dataDir,
    cleanup: async () => {
      server.stop(true);
      if (opts?.apiKey) {
        if (origApiKey !== undefined) {
          process.env.API_KEY = origApiKey;
        } else {
          delete process.env.API_KEY;
        }
      }
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Convenience wrapper around fetch that prepends the base URL and sets JSON headers.
 */
export function e2eFetch(
  baseUrl: string,
  path: string,
  init?: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
  const headers = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

/**
 * Deploy a mock graph that echoes its input via the real HTTP API.
 */
export async function e2eDeployGraph(
  baseUrl: string,
  name: string,
  opts?: { code?: string; apiKey?: string },
): Promise<Response> {
  const code =
    opts?.code ??
    `
    module.exports.graph = {
      invoke: async (input, config) => {
        return { echo: input, ts: Date.now() };
      },
      stream: async function* (input, config) {
        yield { echo: input };
      },
    };
  `;

  const headers: Record<string, string> = {};
  if (opts?.apiKey) headers["X-API-Key"] = opts.apiKey;

  return e2eFetch(baseUrl, "/api/graphs/deploy", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, code }),
  });
}

export const FAILING_GRAPH_CODE = `
  module.exports.graph = {
    invoke: async (input, config) => { throw new Error("graph-error"); },
    stream: async function* (input, config) { yield input; },
  };
`;

export const BUILDER_GRAPH_CODE = `
  module.exports.builder = (env) => ({
    invoke: async (input, config) => {
      return { echo: input, env };
    },
    stream: async function* (input, config) {
      yield { echo: input };
    },
  });
`;

export function json(res: Response): Promise<any> {
  return res.json() as Promise<any>;
}

export async function computeHmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
