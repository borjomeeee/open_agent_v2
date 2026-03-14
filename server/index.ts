import { Hono } from "hono";
import { logger } from "hono/logger";
import { join } from "path";
import { mkdir } from "fs/promises";
import { GraphRegistry } from "./registry.ts";
import { loadGraphsFromFile } from "./loader.ts";
import { decryptEnvVars } from "../lib/crypto.ts";
import { ChannelManager } from "./channels/manager.ts";
import { createChannelRoutes, createIngressRoutes } from "./channels/routes.ts";
import { startCronChannel } from "./channels/handlers/cron.ts";
import type { CronConfig } from "./channels/types.ts";

export async function createServer(dataDir: string) {
  await mkdir(dataDir, { recursive: true });

  const registry = new GraphRegistry(dataDir);
  await registry.init();

  await loadActiveGraphs(registry);

  const channelManager = new ChannelManager(dataDir, registry);
  await channelManager.init();

  const app = new Hono();

  app.use("*", logger());

  app.use("/api/*", async (c, next) => {
    const apiKey = process.env.API_KEY;
    if (apiKey) {
      const provided = c.req.header("X-API-Key");
      if (provided !== apiKey) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    }
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  // ─── Public ingress routes (no API key) ─────────────────────────
  app.route("/hooks", createIngressRoutes(channelManager));

  app.get("/api/graphs", (c) => {
    const graphs = registry.listAll();
    return c.json({ graphs });
  });

  app.get("/api/graphs/:name", (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }
    return c.json(entry);
  });

  app.post("/api/graphs/deploy", async (c) => {
    const body = await c.req.json();
    const { name, code } = body as { name: string; code: string };

    if (!name || !code) {
      return c.json({ error: "Missing 'name' and 'code' fields" }, 400);
    }

    let deployEnv: Record<string, string> | undefined;
    if (body.env && typeof body.env === "object") {
      deployEnv = body.env as Record<string, string>;

      const isEncrypted = c.req.header("X-Env-Encrypted") === "true";
      if (isEncrypted) {
        const encryptionKey = process.env.OPENAGENT_ENCRYPTION_KEY;
        if (!encryptionKey) {
          return c.json(
            { error: "Client sent encrypted env vars but OPENAGENT_ENCRYPTION_KEY is not set on the server" },
            400,
          );
        }
        try {
          deployEnv = decryptEnvVars(deployEnv, encryptionKey);
        } catch (err: any) {
          return c.json(
            { error: `Failed to decrypt env vars: ${err.message}. Check that client and server use the same encryption key.` },
            400,
          );
        }
      }
    }

    const fileName = `${name}.js`;
    const filePath = join(dataDir, fileName);
    await Bun.write(filePath, code);

    try {
      const graphEnv = deployEnv ?? registry.getEnv(name);
      const graphs = await loadGraphsFromFile(filePath, graphEnv);
      const exportNames = Object.keys(graphs);

      if (exportNames.length === 0) {
        return c.json(
          {
            error:
              "No compiled LangGraph instances found in exports. Make sure your workflow exports a compiled StateGraph or a builder function.",
          },
          400,
        );
      }

      await registry.register(name, fileName, exportNames, deployEnv);

      const primaryExport = exportNames[0]!;
      registry.setGraphInstance(name, graphs[primaryExport]);

      return c.json({
        message: `Graph '${name}' deployed and activated`,
        exports: exportNames,
        activeExport: primaryExport,
      });
    } catch (err: any) {
      return c.json({ error: `Failed to load graph: ${err.message}` }, 500);
    }
  });

  app.post("/api/graphs/:name/start", async (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }

    if (entry.active && registry.getGraphInstance(name)) {
      return c.json({ message: `Graph '${name}' is already active` });
    }

    const filePath = registry.getFilePath(name)!;
    try {
      const graphEnv = registry.getEnv(name);
      const graphs = await loadGraphsFromFile(filePath, graphEnv);
      const primaryExport = entry.exports[0]!;
      registry.setGraphInstance(name, graphs[primaryExport]);
      await registry.activate(name);
      return c.json({ message: `Graph '${name}' activated` });
    } catch (err: any) {
      return c.json(
        { error: `Failed to load graph: ${err.message}` },
        500,
      );
    }
  });

  app.post("/api/graphs/:name/stop", async (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }

    await registry.deactivate(name);
    return c.json({ message: `Graph '${name}' deactivated` });
  });

  // ─── Channel management ─────────────────────────────────────────
  app.route("/api/channels", createChannelRoutes(channelManager));

  // ─── Per-graph env management ──────────────────────────────────

  app.get("/api/graphs/:name/env", (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }
    const env = registry.getEnv(name);
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      masked[key] = value.length > 8
        ? value.slice(0, 4) + "****" + value.slice(-4)
        : "****";
    }
    return c.json({ env: masked });
  });

  app.put("/api/graphs/:name/env", async (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }
    const body = await c.req.json();
    let vars = body.vars as Record<string, string>;
    if (!vars || typeof vars !== "object") {
      return c.json({ error: "Missing 'vars' object in body" }, 400);
    }

    const isEncrypted = c.req.header("X-Env-Encrypted") === "true";
    if (isEncrypted) {
      const encryptionKey = process.env.OPENAGENT_ENCRYPTION_KEY;
      if (!encryptionKey) {
        return c.json(
          { error: "Client sent encrypted env vars but OPENAGENT_ENCRYPTION_KEY is not set on the server" },
          400,
        );
      }
      try {
        vars = decryptEnvVars(vars, encryptionKey);
      } catch (err: any) {
        return c.json(
          { error: `Failed to decrypt env vars: ${err.message}. Check that client and server use the same encryption key.` },
          400,
        );
      }
    }

    await registry.setEnv(name, vars);

    if (entry.active) {
      const filePath = registry.getFilePath(name)!;
      try {
        const graphEnv = registry.getEnv(name);
        const graphs = await loadGraphsFromFile(filePath, graphEnv);
        const primaryExport = entry.exports[0]!;
        if (graphs[primaryExport]) {
          registry.setGraphInstance(name, graphs[primaryExport]);
        }
      } catch (err: any) {
        return c.json({
          message: "Env vars saved but graph reload failed",
          error: err.message,
        }, 500);
      }
    }

    return c.json({ message: `Env vars updated for '${name}'` });
  });

  app.delete("/api/graphs/:name", async (c) => {
    const { name } = c.req.param();
    const removed = await registry.remove(name);
    if (!removed) {
      return c.json({ error: "Graph not found" }, 404);
    }
    return c.json({ message: `Graph '${name}' removed` });
  });

  await restoreActiveChannels(channelManager);

  return app;
}

async function restoreActiveChannels(channelManager: ChannelManager) {
  const channels = channelManager.listAll().filter((c) => c.active);

  for (const ch of channels) {
    try {
      if (ch.type === "cron") {
        startCronChannel(ch, channelManager);
        console.log(`Restored cron channel: ${ch.id} (${(ch.config as CronConfig).schedule})`);
      }
    } catch (err: any) {
      console.error(`Failed to restore channel ${ch.id}: ${err.message}`);
    }
  }
}

async function loadActiveGraphs(registry: GraphRegistry) {
  const entries = registry.listAll().filter((e) => e.active);

  for (const entry of entries) {
    const filePath = registry.getFilePath(entry.name);
    if (!filePath) continue;

    try {
      const graphEnv = registry.getEnv(entry.name);
      const graphs = await loadGraphsFromFile(filePath, graphEnv);
      const primaryExport = entry.exports[0]!;
      if (graphs[primaryExport]) {
        registry.setGraphInstance(entry.name, graphs[primaryExport]);
        console.log(`Loaded graph: ${entry.name}`);
      }
    } catch (err: any) {
      console.error(
        `Failed to load graph '${entry.name}': ${err.message}`,
      );
    }
  }
}
