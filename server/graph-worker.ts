import { resolve } from "path";
import { logger } from "./logger.ts";

const log = logger.child({ module: "graph" });

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
};

interface RunMessage {
  filePath: string;
  exportName: string;
  graphName: string;
  input: unknown;
  threadId?: string;
  env: Record<string, string>;
}

self.onmessage = async (event: MessageEvent<RunMessage>) => {
  const { filePath, exportName, graphName, input, threadId, env } = event.data;

  try {
    const absPath = resolve(filePath);
    const mod = require(absPath);
    const builder = mod[exportName];

    if (typeof builder !== "function") {
      throw new Error(`Export '${exportName}' from '${filePath}' is not a function`);
    }

    const graph = builder(env);

    const config: Record<string, unknown> = {
      ...(threadId && { configurable: { thread_id: threadId } }),
      streamMode: "updates"
    };

    const start = Date.now();
    log.info({ graph: graphName, threadId }, "graph:start");

    let result: any;
    for await (const chunk of await graph.stream({ input }, config)) {
      const [nodeName] = Object.keys(chunk);
      log.info({ graph: graphName, threadId, node: nodeName }, "node:complete");
      result = chunk;
    }

    log.info({ graph: graphName, threadId, durationMs: Date.now() - start }, "graph:complete");

    self.postMessage({ ok: true, result });
  } catch (err: any) {
    log.error({ graph: graphName, threadId, err: err?.message }, "graph:error");
    self.postMessage({ ok: false, error: err?.message ?? String(err) });
  }
};
