import { Hono } from "hono";
import { join } from "path";
import type { GraphRegistry } from "../registry.ts";
import { loadBuildersFromFile } from "../loader.ts";
import { decryptEnvVars } from "../../lib/crypto.ts";

export function createGraphRoutes(registry: GraphRegistry, dataDir: string) {
  const app = new Hono();

  app.get("/", (c) => {
    const graphs = registry.listAll();
    return c.json({ graphs });
  });

  app.get("/:name", (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }
    return c.json(entry);
  });

  app.post("/deploy", async (c) => {
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
      const builders = await loadBuildersFromFile(filePath);
      const exportNames = Object.keys(builders);

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
      registry.setGraphBuilder(name, builders[primaryExport]!);

      return c.json({
        message: `Graph '${name}' deployed and activated`,
        exports: exportNames,
        activeExport: primaryExport,
      });
    } catch (err: any) {
      return c.json({ error: `Failed to load graph: ${err.message}` }, 500);
    }
  });

  app.post("/:name/start", async (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }

    if (entry.active && registry.getGraphBuilder(name)) {
      return c.json({ message: `Graph '${name}' is already active` });
    }

    const filePath = registry.getFilePath(name)!;
    try {
      const builders = await loadBuildersFromFile(filePath);
      const primaryExport = entry.exports[0]!;
      registry.setGraphBuilder(name, builders[primaryExport]!);
      await registry.activate(name);
      return c.json({ message: `Graph '${name}' activated` });
    } catch (err: any) {
      return c.json(
        { error: `Failed to load graph: ${err.message}` },
        500,
      );
    }
  });

  app.post("/:name/stop", async (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }

    await registry.deactivate(name);
    return c.json({ message: `Graph '${name}' deactivated` });
  });

  // ─── Per-graph env management ──────────────────────────────────

  app.get("/:name/env", (c) => {
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

  app.put("/:name/env", async (c) => {
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

    // No graph reload needed — builder(env) is called fresh on each job execution,
    // so updated env vars are picked up automatically.

    return c.json({ message: `Env vars updated for '${name}'` });
  });

  app.delete("/:name", async (c) => {
    const { name } = c.req.param();
    const removed = await registry.remove(name);
    if (!removed) {
      return c.json({ error: "Graph not found" }, 404);
    }
    return c.json({ message: `Graph '${name}' removed` });
  });

  return app;
}
