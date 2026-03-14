import type { ChannelManager } from "../manager.ts";

export async function triggerGraphChannels(
  sourceGraphName: string,
  result: any,
  channelManager: ChannelManager,
) {
  const channels = channelManager.getActiveByType("graph", { sourceGraph: sourceGraphName });

  for (const ch of channels) {
    try {
      await channelManager.invokeGraph(ch.graphName, result, 1);
    } catch (err: any) {
      console.error(`Graph channel ${ch.id} (${sourceGraphName} -> ${ch.graphName}) failed: ${err.message}`);
    }
  }
}
