import { CronJob } from "cron";
import type { ChannelManager } from "../manager.ts";
import type { Channel, CronConfig } from "../types.ts";
import { logger } from "../../logger.ts";

const log = logger.child({ module: "cron" });

export function startCronChannel(channel: Channel, channelManager: ChannelManager) {
  const config = channel.config as CronConfig;

  const job = new CronJob(config.schedule, () => {
    log.info({ channelId: channel.id, graph: channel.graphName }, "Invoking graph");
    channelManager.invokeGraph(channel.graphName, config.input, undefined, {
      onComplete: async (result) => {
        log.info({ channelId: channel.id, graph: channel.graphName }, "Cron graph invocation completed");
      },
      onError: async (err) => {
        log.error({ channelId: channel.id, err }, "Cron invocation error");
      },
    });
  });

  job.start();
  channelManager.setCronJob(channel.id, job);
}

export function stopCronChannel(channelId: string, channelManager: ChannelManager) {
  channelManager.stopCronJob(channelId);
}
