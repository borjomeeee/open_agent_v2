import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { GraphQueue } from "../../server/queue.ts";
import { GraphRegistry } from "../../server/registry.ts";
import type { CompiledGraph } from "../../server/loader.ts";

interface Deferred<T = any> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T = any>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface MockGraphHandle {
  graph: CompiledGraph;
  invocations: { input: any; config: any }[];
  setHandler: (fn: (input: any, config: any) => Promise<any>) => void;
}

function createMockGraph(): MockGraphHandle {
  let handler: (input: any, config: any) => Promise<any> = async (input) => ({ echo: input });
  const invocations: { input: any; config: any }[] = [];

  const graph: CompiledGraph = {
    invoke: async (input: any, config: any) => {
      invocations.push({ input, config });
      return handler(input, config);
    },
    stream: async function* (input: any) {
      yield { echo: input };
    },
  };

  return {
    graph,
    invocations,
    setHandler: (fn) => { handler = fn; },
  };
}

async function setupQueue(opts?: { maxConcurrency?: number; maxRetries?: number }) {
  const dataDir = await mkdtemp(join(tmpdir(), "openagent-queue-test-"));
  const registry = new GraphRegistry(dataDir);
  await registry.init();

  const queue = new GraphQueue(dataDir, registry, {
    maxConcurrency: opts?.maxConcurrency ?? 1,
    maxRetries: opts?.maxRetries ?? 0,
  });

  return { dataDir, registry, queue };
}

describe("Queue batching", () => {
  let dataDir: string;
  let registry: GraphRegistry;
  let queue: GraphQueue;

  afterEach(async () => {
    queue.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("single job executes normally with original input", async () => {
    ({ dataDir, registry, queue } = await setupQueue());

    const mock = createMockGraph();
    await registry.register("echo", "echo.js", ["graph"]);
    registry.setGraphInstance("echo", mock.graph);

    const result = await queue.enqueueAndWait("echo", { msg: "hello" });
    expect(result).toEqual({ echo: { msg: "hello" } });
    expect(mock.invocations.length).toBe(1);
    expect(mock.invocations[0]!.input).toEqual({ msg: "hello" });
  });

  test("batches pending jobs for same graph+thread when worker is busy", async () => {
    ({ dataDir, registry, queue } = await setupQueue({ maxConcurrency: 1 }));

    const mock = createMockGraph();
    await registry.register("echo", "echo.js", ["graph"]);
    registry.setGraphInstance("echo", mock.graph);

    const gate = deferred();

    mock.setHandler(async (input) => {
      if (input.msg === "blocker") {
        await gate.promise;
        return { echo: input };
      }
      return { echo: input };
    });

    const blockerPromise = queue.enqueueAndWait("echo", { msg: "blocker" }, "thread-1");

    await Bun.sleep(10);
    expect(queue.stats().active).toBe(1);

    const p1 = queue.enqueueAndWait("echo", { msg: "event-1" }, "thread-1");
    const p2 = queue.enqueueAndWait("echo", { msg: "event-2" }, "thread-1");

    expect(queue.stats().pending).toBe(2);

    gate.resolve(undefined);
    await blockerPromise;

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mock.invocations.length).toBe(2);

    const batchedCall = mock.invocations[1]!;
    expect(batchedCall.input).toEqual({
      inputs: [{ msg: "event-1" }, { msg: "event-2" }],
    });

    expect(r1).toEqual(r2);
  });

  test("3 pending jobs are batched into single execution", async () => {
    ({ dataDir, registry, queue } = await setupQueue({ maxConcurrency: 1 }));

    const mock = createMockGraph();
    await registry.register("echo", "echo.js", ["graph"]);
    registry.setGraphInstance("echo", mock.graph);

    const gate = deferred();
    mock.setHandler(async (input) => {
      if (input.msg === "blocker") {
        await gate.promise;
      }
      return { echo: input };
    });

    const blockerPromise = queue.enqueueAndWait("echo", { msg: "blocker" }, "thread-1");
    await Bun.sleep(10);

    const p1 = queue.enqueueAndWait("echo", { msg: "a" }, "thread-1");
    const p2 = queue.enqueueAndWait("echo", { msg: "b" }, "thread-1");
    const p3 = queue.enqueueAndWait("echo", { msg: "c" }, "thread-1");

    expect(queue.stats().pending).toBe(3);

    gate.resolve(undefined);
    await blockerPromise;

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    const batchedCall = mock.invocations[1]!;
    expect(batchedCall.input).toEqual({
      inputs: [{ msg: "a" }, { msg: "b" }, { msg: "c" }],
    });

    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });

  test("jobs for different threads are NOT batched together", async () => {
    ({ dataDir, registry, queue } = await setupQueue({ maxConcurrency: 1 }));

    const mock = createMockGraph();
    await registry.register("echo", "echo.js", ["graph"]);
    registry.setGraphInstance("echo", mock.graph);

    const gate = deferred();
    mock.setHandler(async (input) => {
      if (input.msg === "blocker") {
        await gate.promise;
      }
      return { echo: input };
    });

    const blockerPromise = queue.enqueueAndWait("echo", { msg: "blocker" }, "thread-1");
    await Bun.sleep(10);

    const pA = queue.enqueueAndWait("echo", { msg: "for-thread-2" }, "thread-2");
    const pB = queue.enqueueAndWait("echo", { msg: "for-thread-3" }, "thread-3");

    gate.resolve(undefined);
    await blockerPromise;
    await Promise.all([pA, pB]);

    expect(mock.invocations.length).toBe(3);
    expect(mock.invocations[1]!.input).toEqual({ msg: "for-thread-2" });
    expect(mock.invocations[2]!.input).toEqual({ msg: "for-thread-3" });
  });

  test("jobs without thread_id for same graph are still batched", async () => {
    ({ dataDir, registry, queue } = await setupQueue({ maxConcurrency: 1 }));

    const mock = createMockGraph();
    await registry.register("echo", "echo.js", ["graph"]);
    registry.setGraphInstance("echo", mock.graph);

    const gate = deferred();
    mock.setHandler(async (input) => {
      if (input.msg === "blocker") {
        await gate.promise;
      }
      return { echo: input };
    });

    const blockerPromise = queue.enqueueAndWait("echo", { msg: "blocker" });
    await Bun.sleep(10);

    const p1 = queue.enqueueAndWait("echo", { msg: "no-thread-1" });
    const p2 = queue.enqueueAndWait("echo", { msg: "no-thread-2" });

    gate.resolve(undefined);
    await blockerPromise;
    await Promise.all([p1, p2]);

    const batchedCalls = mock.invocations.filter((i) => i.input.msg !== "blocker");
    expect(batchedCalls.length).toBe(1);
    expect(batchedCalls[0]!.input).toEqual({
      inputs: [{ msg: "no-thread-1" }, { msg: "no-thread-2" }],
    });
  });

  test("all batched waiters receive the same result", async () => {
    ({ dataDir, registry, queue } = await setupQueue({ maxConcurrency: 1 }));

    const mock = createMockGraph();
    await registry.register("echo", "echo.js", ["graph"]);
    registry.setGraphInstance("echo", mock.graph);

    const gate = deferred();
    mock.setHandler(async (input) => {
      if (input.msg === "blocker") {
        await gate.promise;
        return { done: "blocker" };
      }
      return { batched: true, count: input.inputs?.length ?? 1 };
    });

    const blockerPromise = queue.enqueueAndWait("echo", { msg: "blocker" }, "t1");
    await Bun.sleep(10);

    const p1 = queue.enqueueAndWait("echo", { msg: "x" }, "t1");
    const p2 = queue.enqueueAndWait("echo", { msg: "y" }, "t1");
    const p3 = queue.enqueueAndWait("echo", { msg: "z" }, "t1");

    gate.resolve(undefined);
    await blockerPromise;

    const results = await Promise.all([p1, p2, p3]);
    const expected = { batched: true, count: 3 };
    expect(results[0]).toEqual(expected);
    expect(results[1]).toEqual(expected);
    expect(results[2]).toEqual(expected);
  });

  test("batching only happens when worker is busy, not when idle", async () => {
    ({ dataDir, registry, queue } = await setupQueue({ maxConcurrency: 5 }));

    const mock = createMockGraph();
    await registry.register("echo", "echo.js", ["graph"]);
    registry.setGraphInstance("echo", mock.graph);

    const r1 = await queue.enqueueAndWait("echo", { msg: "first" }, "thread-1");
    const r2 = await queue.enqueueAndWait("echo", { msg: "second" }, "thread-1");

    expect(mock.invocations.length).toBe(2);
    expect(mock.invocations[0]!.input).toEqual({ msg: "first" });
    expect(mock.invocations[1]!.input).toEqual({ msg: "second" });
  });

  test("queue stats reflect pending and active counts", async () => {
    ({ dataDir, registry, queue } = await setupQueue({ maxConcurrency: 1 }));

    const mock = createMockGraph();
    await registry.register("echo", "echo.js", ["graph"]);
    registry.setGraphInstance("echo", mock.graph);

    expect(queue.stats()).toEqual({ active: 0, pending: 0 });

    const gate = deferred();
    mock.setHandler(async (input) => {
      await gate.promise;
      return { echo: input };
    });

    const p = queue.enqueueAndWait("echo", { msg: "x" }, "t1");
    await Bun.sleep(10);

    expect(queue.stats().active).toBe(1);

    queue.enqueue("echo", { msg: "queued-1" }, { threadId: "t1" });
    queue.enqueue("echo", { msg: "queued-2" }, { threadId: "t1" });

    expect(queue.stats().pending).toBe(2);

    gate.resolve(undefined);
    await p;
    await Bun.sleep(50);

    expect(queue.stats().active).toBe(0);
    expect(queue.stats().pending).toBe(0);
  });
});
