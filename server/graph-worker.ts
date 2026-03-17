import type { CompiledStateGraph } from "@langchain/langgraph";
import { resolve } from "path";

export type GraphBuilder = (
  env: Record<string, string>,
) => CompiledStateGraph<any, any>;

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
};

interface RunMessage {
  filePath: string;
  exportName: string;
  input: unknown;
  threadId?: string;
  env: Record<string, string>;
}

self.onmessage = async (event: MessageEvent<RunMessage>) => {
  const { filePath, exportName, input, threadId, env } = event.data;

  try {
    const absPath = resolve(filePath);
    const mod = require(absPath);
    const builder = mod[exportName] as GraphBuilder;

    if (typeof builder !== "function") {
      throw new Error(
        `Export '${exportName}' from '${filePath}' is not a function`,
      );
    }

    const graph = builder(env);

    const config: Record<string, unknown> = {
      ...(threadId && { configurable: { thread_id: threadId } }),
    };
    
    const result = await graph.invoke({ input }, config);
    self.postMessage({ ok: true, result });
  } catch (err: any) {
    self.postMessage({ ok: false, error: err?.message ?? String(err) });
  }
};
