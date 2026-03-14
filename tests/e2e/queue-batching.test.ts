import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startE2EServer,
  e2eFetch,
  e2eDeployGraph,
  json,
  type E2EContext,
} from "../helpers/e2e-setup.ts";

const SLOW_GRAPH_CODE = `
  module.exports.graph = {
    invoke: async (input, config) => {
      if (input.delay) {
        await new Promise(r => setTimeout(r, input.delay));
      }
      return { echo: input, ts: Date.now() };
    },
    stream: async function* (input, config) {
      yield { echo: input };
    },
  };
`;

describe("E2E: Queue batching over HTTP", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    process.env.MAX_CONCURRENT_RUNS = "1";
    ctx = await startE2EServer();
    await e2eDeployGraph(ctx.baseUrl, "slow", { code: SLOW_GRAPH_CODE });
  });

  afterEach(async () => {
    delete process.env.MAX_CONCURRENT_RUNS;
    await ctx.cleanup();
  });

  async function createAndActivateWebhook(): Promise<string> {
    const res = await e2eFetch(ctx.baseUrl, "/api/channels", {
      method: "POST",
      body: JSON.stringify({ type: "webhook", graphName: "slow", config: {} }),
    });
    const { channel } = await json(res);
    await e2eFetch(ctx.baseUrl, `/api/channels/${channel.id}/start`, {
      method: "POST",
    });
    return channel.id;
  }

  test("concurrent webhooks with same thread_id are batched when worker is busy", async () => {
    const channelId = await createAndActivateWebhook();

    const blockerPromise = e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ delay: 200, thread_id: "batch-thread" }),
    });

    await Bun.sleep(30);

    const statsRes = await e2eFetch(ctx.baseUrl, "/api/queue/stats");
    const stats = await json(statsRes);
    expect(stats.active).toBe(1);

    const p1 = e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ msg: "event-1", thread_id: "batch-thread" }),
    });
    const p2 = e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ msg: "event-2", thread_id: "batch-thread" }),
    });

    const blockerRes = await blockerPromise;
    expect(blockerRes.status).toBe(200);

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = await json(res1);
    const body2 = await json(res2);

    expect(body1.result.echo.inputs).toBeDefined();
    expect(body1.result.echo.inputs.length).toBe(2);
    expect(body1.result.echo.inputs).toEqual([
      { msg: "event-1", thread_id: "batch-thread" },
      { msg: "event-2", thread_id: "batch-thread" },
    ]);

    expect(body1.result).toEqual(body2.result);
  });

  test("concurrent webhooks with different thread_ids are NOT batched", async () => {
    const channelId = await createAndActivateWebhook();

    const blockerPromise = e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ delay: 200, thread_id: "thread-A" }),
    });

    await Bun.sleep(30);

    const p1 = e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ msg: "for-B", thread_id: "thread-B" }),
    });
    const p2 = e2eFetch(ctx.baseUrl, `/hooks/${channelId}`, {
      method: "POST",
      body: JSON.stringify({ msg: "for-C", thread_id: "thread-C" }),
    });

    await blockerPromise;
    const [res1, res2] = await Promise.all([p1, p2]);

    const body1 = await json(res1);
    const body2 = await json(res2);

    expect(body1.result.echo).toEqual({ msg: "for-B", thread_id: "thread-B" });
    expect(body2.result.echo).toEqual({ msg: "for-C", thread_id: "thread-C" });
  });
});
