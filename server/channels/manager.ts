import { join } from "path";
import type { Channel, ChannelsData, ChannelType, ChannelConfig, GraphConfig } from "./types.ts";
import type { GraphRegistry } from "../registry.ts";
import type { GraphQueue } from "../queue.ts";
import { logger } from "../logger.ts";

const log = logger.child({ module: "channels" });

export class ChannelManager {
  private data: ChannelsData = { channels: {} };
  private channelsPath: string;
  private cronJobs: Map<string, { stop: () => void }> = new Map();
  private queue!: GraphQueue;

  constructor(
    private dataDir: string,
    private registry: GraphRegistry,
  ) {
    this.channelsPath = join(dataDir, "channels.json");
  }

  setQueue(queue: GraphQueue) {
    this.queue = queue;
  }

  async init() {
    const file = Bun.file(this.channelsPath);
    if (await file.exists()) {
      this.data = await file.json();
    } else {
      await Bun.write(this.channelsPath, JSON.stringify(this.data, null, 2));
    }
  }

  private async save() {
    await Bun.write(this.channelsPath, JSON.stringify(this.data, null, 2));
  }

  async create(
    type: ChannelType,
    graphName: string,
    config: ChannelConfig,
  ): Promise<Channel> {
    const entry = this.registry.getEntry(graphName);
    if (!entry) {
      throw new Error(`Graph '${graphName}' not found`);
    }

    const id = crypto.randomUUID();
    const channel: Channel = {
      id,
      type,
      graphName,
      config,
      active: false,
      createdAt: new Date().toISOString(),
    };

    this.data.channels[id] = channel;
    await this.save();
    return channel;
  }

  async update(id: string, config: ChannelConfig): Promise<Channel> {
    const channel = this.data.channels[id];
    if (!channel) throw new Error(`Channel '${id}' not found`);

    if (channel.active) {
      throw new Error("Stop the channel before updating its config");
    }

    channel.config = config;
    await this.save();
    return channel;
  }

  async remove(id: string): Promise<boolean> {
    const channel = this.data.channels[id];
    if (!channel) return false;

    if (channel.active) {
      await this.deactivate(id);
    }

    delete this.data.channels[id];
    await this.save();
    return true;
  }

  async activate(id: string): Promise<Channel> {
    const channel = this.data.channels[id];
    if (!channel) throw new Error(`Channel '${id}' not found`);

    const entry = this.registry.getEntry(channel.graphName);
    if (!entry?.active) {
      throw new Error(`Graph '${channel.graphName}' is not active`);
    }

    channel.active = true;
    await this.save();
    return channel;
  }

  async deactivate(id: string): Promise<Channel> {
    const channel = this.data.channels[id];
    if (!channel) throw new Error(`Channel '${id}' not found`);

    if (channel.type === "cron") {
      this.stopCronJob(id);
    }

    channel.active = false;
    await this.save();
    return channel;
  }

  getChannel(id: string): Channel | undefined {
    return this.data.channels[id];
  }

  listAll(graphName?: string): Channel[] {
    const all = Object.values(this.data.channels);
    if (graphName) return all.filter((c) => c.graphName === graphName);
    return all;
  }

  getActiveByType(type: ChannelType, filter?: { graphName?: string; sourceGraph?: string }): Channel[] {
    return Object.values(this.data.channels).filter((c) => {
      if (c.type !== type || !c.active) return false;
      if (filter?.graphName && c.graphName !== filter.graphName) return false;
      if (filter?.sourceGraph && (c.config as GraphConfig).sourceGraph !== filter.sourceGraph) return false;
      return true;
    });
  }

  async invokeGraph(graphName: string, input: any, threadId?: string, opts?: {
    onComplete?: (result: any) => Promise<void>;
    onError?: (err: Error) => Promise<void>;
  }): Promise<any> {
    const entry = this.registry.getEntry(graphName);
    if (!entry) throw new Error(`Graph '${graphName}' not found`);
    if (!entry.active) throw new Error(`Graph '${graphName}' is not active`);

    if (opts?.onComplete) {
      const originalOnComplete = opts.onComplete;
      this.queue.enqueue(graphName, input, {
        threadId,
        onComplete: async (result) => {
          await originalOnComplete(result);
          await this.invokeGraphChannels(graphName, result, threadId);
        },
        onError: opts.onError,
      });
      return null;
    }

    const result = await this.queue.enqueueAndWait(graphName, input, threadId);
    await this.invokeGraphChannels(graphName, result, threadId);
    return result;
  }

  private async invokeGraphChannels(graphName: string, result: any, threadId?: string) {
    const graphChannels = this.getActiveByType("graph", { sourceGraph: graphName });
    for (const ch of graphChannels) {
      try {
        await this.queue.enqueueAndWait(ch.graphName, result, threadId);
      } catch (err: any) {
        log.error({ channelId: ch.id, graph: ch.graphName, err }, "Graph channel invocation failed");
      }
    }
  }

  // ─── Cron job management ────────────────────────────────────────

  setCronJob(id: string, job: { stop: () => void }) {
    this.cronJobs.set(id, job);
  }

  stopCronJob(id: string) {
    const job = this.cronJobs.get(id);
    if (job) {
      job.stop();
      this.cronJobs.delete(id);
    }
  }

  stopAllCronJobs() {
    for (const [id] of this.cronJobs) {
      this.stopCronJob(id);
    }
  }
}
