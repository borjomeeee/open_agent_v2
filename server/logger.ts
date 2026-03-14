import pino from "pino";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { ChainValues } from "@langchain/core/utils/types";
import {
  createWriteStream,
  statSync,
  readdirSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  type WriteStream,
} from "fs";
import { join } from "path";

const LOG_DIR = process.env.OPENAGENT_LOG_DIR;
const MAX_FILE_SIZE = parseInt(process.env.LOG_MAX_SIZE || "") || 10 * 1024 * 1024;
const RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || "") || 7;

function cleanupOldLogs(dir: string) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.startsWith("server-") || !file.endsWith(".log")) continue;
      try {
        const st = statSync(join(dir, file));
        if (st.mtimeMs < cutoff) unlinkSync(join(dir, file));
      } catch {}
    }
  } catch {}
}

function createRotatingFileStream(dir: string): { write(msg: string): void } {
  mkdirSync(dir, { recursive: true });

  const logPath = join(dir, "server.log");
  let stream: WriteStream = createWriteStream(logPath, { flags: "a" });
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {}

  cleanupOldLogs(dir);

  return {
    write(msg: string) {
      stream.write(msg);
      size += Buffer.byteLength(msg);
      if (size >= MAX_FILE_SIZE) {
        stream.end();
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        try {
          renameSync(logPath, join(dir, `server-${ts}.log`));
        } catch {}
        stream = createWriteStream(logPath, { flags: "a" });
        size = 0;
        cleanupOldLogs(dir);
      }
    },
  };
}

function createPinoLogger() {
  const level = process.env.LOG_LEVEL || "info";

  if (!LOG_DIR) {
    return pino({ level });
  }

  const streams: pino.StreamEntry[] = [
    { stream: process.stdout },
    { stream: createRotatingFileStream(LOG_DIR) as any },
  ];

  return pino({ level }, pino.multistream(streams));
}

export const logger = createPinoLogger();

export class LoggingCallbackHandler extends BaseCallbackHandler {
  name = "LoggingCallbackHandler";

  private log = logger.child({ module: "graph" });
  private timers = new Map<string, number>();

  constructor(private graphName: string) {
    super();
    this.ignoreLLM = true;
    this.ignoreRetriever = true;
    this.ignoreAgent = true;
  }

  override handleChainStart(
    _chain: Serialized,
    _inputs: ChainValues,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ) {
    this.timers.set(runId, Date.now());
    this.log.debug({ graph: this.graphName, node: runName, runId }, "node:start");
  }

  override handleChainEnd(
    _outputs: ChainValues,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
  ) {
    const start = this.timers.get(runId);
    const durationMs = start ? Date.now() - start : undefined;
    this.timers.delete(runId);
    this.log.debug({ graph: this.graphName, runId, durationMs }, "node:end");
  }

  override handleChainError(
    err: unknown,
    runId: string,
  ) {
    const start = this.timers.get(runId);
    const durationMs = start ? Date.now() - start : undefined;
    this.timers.delete(runId);
    this.log.error({ graph: this.graphName, runId, durationMs, err }, "node:error");
  }
}

export function withLoggingCallbacks(graphName: string, config?: Record<string, any>): Record<string, any> {
  const handler = new LoggingCallbackHandler(graphName);
  const merged = { ...config };
  if (merged.callbacks) {
    merged.callbacks = [...merged.callbacks, handler];
  } else {
    merged.callbacks = [handler];
  }
  return merged;
}
