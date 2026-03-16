import { Hono } from "hono";
import { join } from "path";
import type { GraphRegistry } from "../registry.ts";
import type { GraphQueue } from "../queue.ts";
import { validateGraphFile } from "../loader.ts";
import { decryptEnvVars } from "../../lib/crypto.ts";

export function createGraphRoutes(registry: GraphRegistry, dataDir: string, queue: GraphQueue) {
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
      const exportNames = await validateGraphFile(filePath);

      if (exportNames.length === 0) {
        return c.json(
          {
            error:
              "No builder functions found in exports. Make sure your workflow exports a builder function.",
          },
          400,
        );
      }

      await registry.register(name, fileName, exportNames, deployEnv);

      return c.json({
        message: `Graph '${name}' deployed and activated`,
        exports: exportNames,
        activeExport: exportNames[0]!,
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

    if (entry.active) {
      return c.json({ message: `Graph '${name}' is already active` });
    }

    const filePath = registry.getFilePath(name)!;
    try {
      await validateGraphFile(filePath);
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

  app.post("/:name/run", async (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);
    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }
    if (!entry.active) {
      return c.json({ error: `Graph '${name}' is not active` }, 409);
    }

    let body: any = {};
    try {
      body = await c.req.json();
    } catch {
      // no body is fine
    }

    const { input = "", thread_id } = body as { input?: any; thread_id?: string };

    try {
      const result = await queue.enqueueAndWait(name, input, thread_id);
      return c.json({ result });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
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

    // No graph reload needed — builder() is called fresh inside a Worker on each
    // job execution, so env vars stored in the registry are always up to date.

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
