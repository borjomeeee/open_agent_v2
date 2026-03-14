import { CronJob } from "cron";
import type { ChannelManager } from "../manager.ts";
import type { Channel, CronConfig } from "../types.ts";

export function startCronChannel(channel: Channel, channelManager: ChannelManager) {
  const config = channel.config as CronConfig;

  const job = new CronJob(config.schedule, async () => {
    try {
      console.log(`Cron channel ${channel.id}: invoking graph '${channel.graphName}'`);
      await channelManager.invokeGraph(channel.graphName, config.input);
    } catch (err: any) {
      console.error(`Cron channel ${channel.id} error: ${err.message}`);
    }
  });

  job.start();
  channelManager.setCronJob(channel.id, job);
}

export function stopCronChannel(channelId: string, channelManager: ChannelManager) {
  channelManager.stopCronJob(channelId);
}
