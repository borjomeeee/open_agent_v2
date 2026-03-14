import { Hono } from "hono";
import { logger } from "hono/logger";
import { join } from "path";
import { mkdir } from "fs/promises";
import { GraphRegistry } from "./registry.ts";
import { loadGraphsFromFile } from "./loader.ts";

export async function createServer(dataDir: string) {
  await mkdir(dataDir, { recursive: true });

  const registry = new GraphRegistry(dataDir);
  await registry.init();

  await loadActiveGraphs(registry);

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

    const fileName = `${name}.js`;
    const filePath = join(dataDir, fileName);
    await Bun.write(filePath, code);

    try {
      const graphs = await loadGraphsFromFile(filePath);
      const exportNames = Object.keys(graphs);

      if (exportNames.length === 0) {
        return c.json(
          {
            error:
              "No compiled LangGraph instances found in exports. Make sure your workflow exports a compiled StateGraph.",
          },
          400,
        );
      }

      await registry.register(name, fileName, exportNames);

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
      const graphs = await loadGraphsFromFile(filePath);
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

  app.post("/api/graphs/:name/invoke", async (c) => {
    const { name } = c.req.param();
    const entry = registry.getEntry(name);

    if (!entry) {
      return c.json({ error: "Graph not found" }, 404);
    }

    if (!entry.active) {
      return c.json({ error: `Graph '${name}' is not active` }, 400);
    }

    const graph = registry.getGraphInstance(name);
    if (!graph) {
      return c.json(
        { error: `Graph '${name}' is registered but not loaded` },
        500,
      );
    }

    try {
      const input = await c.req.json();
      const config = input._config;
      delete input._config;

      const result = await graph.invoke(input, config);
      return c.json({ result });
    } catch (err: any) {
      return c.json({ error: `Invocation failed: ${err.message}` }, 500);
    }
  });

  app.delete("/api/graphs/:name", async (c) => {
    const { name } = c.req.param();
    const removed = await registry.remove(name);
    if (!removed) {
      return c.json({ error: "Graph not found" }, 404);
    }
    return c.json({ message: `Graph '${name}' removed` });
  });

  return app;
}

async function loadActiveGraphs(registry: GraphRegistry) {
  const entries = registry.listAll().filter((e) => e.active);

  for (const entry of entries) {
    const filePath = registry.getFilePath(entry.name);
    if (!filePath) continue;

    try {
      const graphs = await loadGraphsFromFile(filePath);
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
