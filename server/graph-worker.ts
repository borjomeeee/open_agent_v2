import { resolve } from "path";
import { LoggingCallbackHandler } from "./logger.ts";

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
      callbacks: [new LoggingCallbackHandler(graphName)],
      ...(threadId && { configurable: { thread_id: threadId } }),
    };

    const result = await graph.invoke({ input }, config);

    self.postMessage({ ok: true, result });
  } catch (err: any) {
    self.postMessage({ ok: false, error: err?.message ?? String(err) });
  }
};
