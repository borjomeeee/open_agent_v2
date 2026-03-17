import { Hono } from "hono";
import { mkdir } from "fs/promises";
import { GraphRegistry } from "./registry.ts";
import { GraphQueue } from "./queue.ts";
import { validateGraphFile } from "./loader.ts";
import { ChannelManager } from "./channels/manager.ts";
import { createGraphRoutes } from "./routes/graphs.ts";
import { createChannelRoutes, createIngressRoutes } from "./routes/channels.ts";
import { httpLogger, apiKeyAuth } from "./middleware.ts";
import { startCronChannel } from "./channels/handlers/cron.ts";
import type { CronConfig } from "./channels/types.ts";
import { logger } from "./logger.ts";

const log = logger.child({ module: "server" });

export async function createServer(dataDir: string): Promise<{ app: Hono; shutdown: () => void }> {
  await mkdir(dataDir, { recursive: true });

  const registry = new GraphRegistry(dataDir);
  await registry.init();

  await loadActiveGraphs(registry);

  const queue = new GraphQueue(dataDir, registry);
  queue.recoverOnStartup();

  const channelManager = new ChannelManager(dataDir, registry);
  channelManager.setQueue(queue);
  await channelManager.init();

  const app = new Hono();

  app.use("*", httpLogger);
  app.use("/api/*", apiKeyAuth);

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.route("/hooks", createIngressRoutes(channelManager));
  app.route("/api/graphs", createGraphRoutes(registry, dataDir, queue));
  app.route("/api/channels", createChannelRoutes(channelManager));

  app.get("/api/queue/stats", (c) => c.json(queue.stats()));

  await restoreActiveChannels(channelManager);

  function shutdown() {
    log.info("Shutting down server");
    channelManager.stopAllCronJobs();
    queue.shutdown();
    log.info("Server shutdown complete");
  }

  log.debug("Server created");

  return { app, shutdown };
}

async function restoreActiveChannels(channelManager: ChannelManager) {
  const channels = channelManager.listAll().filter((c) => c.active);

  for (const ch of channels) {
    try {
      if (ch.type === "cron") {
        startCronChannel(ch, channelManager);
        log.info({ channelId: ch.id, schedule: (ch.config as CronConfig).schedule }, "Restored cron channel");
      }
    } catch (err: any) {
      log.error({ channelId: ch.id, err }, "Failed to restore channel");
    }
  }
}

async function loadActiveGraphs(registry: GraphRegistry) {
  const entries = registry.listAll().filter((e) => e.active);

  for (const entry of entries) {
    const filePath = registry.getFilePath(entry.name);
    if (!filePath) continue;

    try {
      await validateGraphFile(filePath);
      log.info({ graph: entry.name }, "Validated graph file");
    } catch (err: any) {
      log.warn({ graph: entry.name, err }, "Graph file invalid or missing; marking inactive");
      await registry.deactivate(entry.name);
    }
  }
}
