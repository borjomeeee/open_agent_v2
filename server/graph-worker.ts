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
  type?: "run" | "abort";
  filePath: string;
  exportName: string;
  input: unknown;
  threadId?: string;
  env: Record<string, string>;
}

let runAbort: AbortController | null = null;

self.onmessage = async (event: MessageEvent<RunMessage>) => {
  const data = event.data;

  if (data.type === "abort") {
    runAbort?.abort();
    return;
  }

  const { filePath, exportName, input, threadId, env } = data;
  runAbort = new AbortController();

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
      signal: runAbort.signal,
    };

    const result = await graph.invoke({ input }, config);
    self.postMessage({ ok: true, result });
  } catch (err: any) {
    if (runAbort?.signal.aborted) {
      self.postMessage({ ok: false, error: "Run aborted", aborted: true });
    } else {
      self.postMessage({ ok: false, error: err?.message ?? String(err) });
    }
  } finally {
    process.exit(0);
  }
};
