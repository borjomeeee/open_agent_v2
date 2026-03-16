import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Hono } from "hono";

export interface TestContext {
  app: Hono;
  dataDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Generates JS source for a mock graph that echoes its input.
 * Exports a builder function () => CompiledGraph as required by the runtime.
 */
export function mockGraphCode(opts?: { fail?: boolean }): string {
  if (opts?.fail) {
    return `
      module.exports.builder = () => ({
        invoke: async (input, config) => { throw new Error("graph-error"); },
        stream: async function* (input, config) { yield input; },
      });
    `;
  }

  return `
    module.exports.builder = () => ({
      invoke: async (input, config) => {
        return { echo: input, ts: Date.now() };
      },
      stream: async function* (input, config) {
        yield { echo: input };
      },
    });
  `;
}

/**
 * Builder-pattern mock: same shape as mockGraphCode, kept for explicit builder tests.
 */
export function mockBuilderGraphCode(): string {
  return `
    module.exports.builder = () => ({
      invoke: async (input, config) => {
        return { echo: input };
      },
      stream: async function* (input, config) {
        yield { echo: input };
      },
    });
  `;
}

export async function createTestServer(opts?: { apiKey?: string }): Promise<TestContext> {
  const dataDir = await mkdtemp(join(tmpdir(), "openagent-test-"));

  const origApiKey = process.env.API_KEY;
  if (opts?.apiKey) {
    process.env.API_KEY = opts.apiKey;
  } else {
    delete process.env.API_KEY;
  }

  const { createServer } = await import("../../server/index.ts");
  const { app } = await createServer(dataDir);

  return {
    app,
    dataDir,
    cleanup: async () => {
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
 * Deploy a mock graph to the test server and return its name.
 */
export async function deployMockGraph(
  app: Hono,
  name: string,
  code?: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return app.request("/api/graphs/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ name, code: code ?? mockGraphCode() }),
  });
}

export function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    }),
  );
}

export async function json(res: Response): Promise<any> {
  return res.json();
}
