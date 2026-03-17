import pino from "pino";
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
