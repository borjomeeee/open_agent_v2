import { Database } from "bun:sqlite";
import { join } from "path";
import type { GraphRegistry } from "./registry.ts";
import { logger, withLoggingCallbacks } from "./logger.ts";

const log = logger.child({ module: "queue" });

interface JobRow {
  id: string;
  graph_name: string;
  thread_id: string | null;
  input: string;
  status: string;
  result: string | null;
  error: string | null;
  attempts: number;
  max_retries: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface JobCallbacks {
  onComplete?: (result: any) => Promise<void>;
  onError?: (err: Error) => Promise<void>;
}

export class GraphQueue {
  private db: Database;
  private maxConcurrency: number;
  private maxRetries: number;
  private retentionMs: number;
  private activeCount = 0;
  private activeRuns = new Map<string, AbortController>();
  private callbacks = new Map<string, JobCallbacks>();
  private waiters = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private registry: GraphRegistry;

  constructor(dataDir: string, registry: GraphRegistry, opts?: { maxConcurrency?: number; maxRetries?: number; retentionHours?: number }) {
    this.registry = registry;
    this.maxConcurrency = opts?.maxConcurrency ?? (parseInt(process.env.MAX_CONCURRENT_RUNS || "") || 5);
    this.maxRetries = opts?.maxRetries ?? (parseInt(process.env.MAX_JOB_RETRIES || "") || 2);
    this.retentionMs = (opts?.retentionHours ?? (parseInt(process.env.JOB_RETENTION_HOURS || "") || 24)) * 60 * 60 * 1000;

    this.db = new Database(join(dataDir, "queue.db"));
    this.db.run("PRAGMA journal_mode = WAL");
    this.initSchema();
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id           TEXT PRIMARY KEY,
        graph_name   TEXT NOT NULL,
        thread_id    TEXT,
        input        TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        result       TEXT,
        error        TEXT,
        attempts     INTEGER NOT NULL DEFAULT 0,
        max_retries  INTEGER NOT NULL DEFAULT 2,
        created_at   TEXT NOT NULL,
        started_at   TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_thread ON jobs(graph_name, thread_id, status);
    `);
  }

  recoverOnStartup() {
    const stuck = this.db
      .query("UPDATE jobs SET status = 'pending', started_at = NULL WHERE status = 'running' RETURNING id")
      .all() as { id: string }[];

    if (stuck.length > 0) {
      log.info({ count: stuck.length }, "Recovered stuck jobs from previous run");
    }

    this.cleanupOldJobs();
    this.processNext();
  }

  private cleanupOldJobs() {
    const cutoff = new Date(Date.now() - this.retentionMs).toISOString();
    const deleted = this.db
      .query("DELETE FROM jobs WHERE status IN ('completed', 'failed', 'aborted') AND completed_at < ? RETURNING id")
      .all(cutoff) as { id: string }[];

    if (deleted.length > 0) {
      log.debug({ count: deleted.length }, "Cleaned up old jobs");
    }
  }

  enqueue(graphName: string, input: any, opts?: {
    threadId?: string;
    onComplete?: (result: any) => Promise<void>;
    onError?: (err: Error) => Promise<void>;
  }): string {
    const id = crypto.randomUUID();
    const threadId = opts?.threadId ?? null;

    this.db.query(
      "INSERT INTO jobs (id, graph_name, thread_id, input, status, max_retries, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
    ).run(id, graphName, threadId, JSON.stringify(input), this.maxRetries, new Date().toISOString());

    if (opts?.onComplete || opts?.onError) {
      this.callbacks.set(id, { onComplete: opts.onComplete, onError: opts.onError });
    }

    if (threadId) {
      const runKey = `${graphName}::${threadId}`;
      const existing = this.activeRuns.get(runKey);
      if (existing) {
        existing.abort();
        log.info({ graphName, threadId }, "Aborted previous run for thread");
      }
    }

    this.processNext();
    return id;
  }

  enqueueAndWait(graphName: string, input: any, threadId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const jobId = this.enqueue(graphName, input, { threadId });
      this.waiters.set(jobId, { resolve, reject });
    });
  }

  stats(): { active: number; pending: number } {
    const row = this.db.query("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'pending'").get() as { cnt: number };
    return { active: this.activeCount, pending: row.cnt };
  }

  shutdown() {
    for (const [, controller] of this.activeRuns) {
      controller.abort();
    }
    this.activeRuns.clear();
    this.db.close();
  }

  private processNext() {
    if (this.activeCount >= this.maxConcurrency) return;

    const eligible = this.db.query(`
      SELECT DISTINCT graph_name, thread_id FROM jobs
      WHERE status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j2
          WHERE j2.graph_name = jobs.graph_name
            AND ((j2.thread_id IS NULL AND jobs.thread_id IS NULL) OR j2.thread_id = jobs.thread_id)
            AND j2.status = 'running'
        )
      LIMIT 1
    `).get() as { graph_name: string; thread_id: string | null } | null;

    if (!eligible) return;

    const pendingJobs = this.db.query(
      "SELECT * FROM jobs WHERE graph_name = ? AND thread_id IS ? AND status = 'pending' ORDER BY created_at",
    ).all(eligible.graph_name, eligible.thread_id) as JobRow[];

    if (pendingJobs.length === 0) return;

    const jobIds = pendingJobs.map((j) => j.id);
    let mergedInput: any;

    if (pendingJobs.length === 1) {
      mergedInput = [JSON.parse(pendingJobs[0]!.input)];
    } else {
      mergedInput = pendingJobs.map((j) => JSON.parse(j.input));
      log.info({ graphName: eligible.graph_name, threadId: eligible.thread_id, batchSize: pendingJobs.length }, "Batched jobs");
    }

    const placeholders = jobIds.map(() => "?").join(",");
    this.db.query(
      `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id IN (${placeholders})`,
    ).run(new Date().toISOString(), ...jobIds);

    this.activeCount++;

    this.executeJob(jobIds, eligible.graph_name, mergedInput, eligible.thread_id ?? undefined)
      .finally(() => {
        this.activeCount--;
        this.processNext();
      });

    if (this.activeCount < this.maxConcurrency) {
      this.processNext();
    }
  }

  private async executeJob(jobIds: string[], graphName: string, input: any, threadId?: string): Promise<void> {
    const runKey = threadId ? `${graphName}::${threadId}` : `${graphName}::${jobIds[0]}`;
    const controller = new AbortController();
    this.activeRuns.set(runKey, controller);

    try {
      const builder = this.registry.getGraphBuilder(graphName);
      if (!builder) {
        throw new Error(`Graph '${graphName}' is registered but not loaded`);
      }

      const env = this.registry.getEnv(graphName);
      const graph = builder(env);

      const config = withLoggingCallbacks(graphName, {
        signal: controller.signal,
        ...(threadId && { configurable: { thread_id: threadId } }),
      });

      const result = await graph.invoke({ input }, config);

      const now = new Date().toISOString();
      const placeholders = jobIds.map(() => "?").join(",");
      this.db.query(
        `UPDATE jobs SET status = 'completed', result = ?, completed_at = ? WHERE id IN (${placeholders})`,
      ).run(JSON.stringify(result), now, ...jobIds);

      for (const jobId of jobIds) {
        const waiter = this.waiters.get(jobId);
        if (waiter) {
          waiter.resolve(result);
          this.waiters.delete(jobId);
        }
        const cb = this.callbacks.get(jobId);
        if (cb?.onComplete) {
          cb.onComplete(result).catch((err) => log.error({ jobId, err }, "onComplete callback error"));
        }
        this.callbacks.delete(jobId);
      }
    } catch (err: any) {
      if (controller.signal.aborted) {
        log.debug({ graphName, threadId, jobIds }, "Run aborted");
        const now = new Date().toISOString();
        const placeholders = jobIds.map(() => "?").join(",");
        this.db.query(
          `UPDATE jobs SET status = 'aborted', completed_at = ? WHERE id IN (${placeholders})`,
        ).run(now, ...jobIds);
        for (const jobId of jobIds) {
          const waiter = this.waiters.get(jobId);
          if (waiter) {
            waiter.resolve(null);
            this.waiters.delete(jobId);
          }
          this.callbacks.delete(jobId);
        }
        return;
      }

      const now = new Date().toISOString();
      const firstJob = this.db.query("SELECT * FROM jobs WHERE id = ?").get(jobIds[0]!) as JobRow | null;
      const canRetry = firstJob && firstJob.attempts < firstJob.max_retries;

      const placeholders = jobIds.map(() => "?").join(",");

      if (canRetry) {
        this.db.query(
          `UPDATE jobs SET status = 'pending', started_at = NULL WHERE id IN (${placeholders})`,
        ).run(...jobIds);
        log.warn({ graphName, threadId, attempt: firstJob!.attempts, err: err.message }, "Job failed, will retry");
      } else {
        this.db.query(
          `UPDATE jobs SET status = 'failed', error = ?, completed_at = ? WHERE id IN (${placeholders})`,
        ).run(err.message, now, ...jobIds);
        log.error({ graphName, threadId, err }, "Job failed permanently");

        for (const jobId of jobIds) {
          const waiter = this.waiters.get(jobId);
          if (waiter) {
            waiter.reject(err);
            this.waiters.delete(jobId);
          }
          const cb = this.callbacks.get(jobId);
          if (cb?.onError) {
            cb.onError(err).catch((e) => log.error({ jobId, e }, "onError callback error"));
          }
          this.callbacks.delete(jobId);
        }
      }
    } finally {
      if (this.activeRuns.get(runKey) === controller) {
        this.activeRuns.delete(runKey);
      }
    }
  }
}
