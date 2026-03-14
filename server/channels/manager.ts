import { join } from "path";
import type { Channel, ChannelsData, ChannelType, ChannelConfig } from "./types.ts";
import type { GraphRegistry } from "../registry.ts";

export class ChannelManager {
  private data: ChannelsData = { channels: {} };
  private channelsPath: string;
  private cronJobs: Map<string, { stop: () => void }> = new Map();

  constructor(
    private dataDir: string,
    private registry: GraphRegistry,
  ) {
    this.channelsPath = join(dataDir, "channels.json");
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
      if (filter?.sourceGraph && (c.config as any).sourceGraph !== filter.sourceGraph) return false;
      return true;
    });
  }

  async invokeGraph(graphName: string, input: any, chainDepth = 0): Promise<any> {
    const MAX_CHAIN_DEPTH = 10;
    if (chainDepth >= MAX_CHAIN_DEPTH) {
      throw new Error(`Graph channel chain depth exceeded (max ${MAX_CHAIN_DEPTH}). Possible loop detected.`);
    }

    const graph = this.registry.getGraphInstance(graphName);
    if (!graph) {
      throw new Error(`Graph '${graphName}' is not loaded`);
    }

    const result = await graph.invoke(input);

    const graphChannels = this.getActiveByType("graph", { sourceGraph: graphName });
    for (const ch of graphChannels) {
      try {
        await this.invokeGraph(ch.graphName, result, chainDepth + 1);
      } catch (err: any) {
        console.error(`Graph channel ${ch.id} (${ch.graphName}) failed: ${err.message}`);
      }
    }

    return result;
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
