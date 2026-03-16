import type { Command } from "commander";
import { resolve } from "path";
import * as p from "@clack/prompts";
import { loadAppConfig, saveAppConfig } from "./config.ts";

export function registerServerCommands(program: Command) {
  const serverCmd = program.command("server").description("Server management");

  serverCmd
    .command("start")
    .description("Start the openagent server")
    .option("-p, --port <port>", "Port to listen on")
    .option("-d, --data-dir <dir>", "Directory for deployed graphs")
    .option("--foreground", "Run in foreground (don't daemonize)")
    .action(async (opts) => {
      const config = await loadAppConfig();
      const saved = config.serverConfig;

      const port = parseInt(opts.port || "") || saved?.port || 3000;
      const dataDir = resolve(opts.dataDir || saved?.dataDir || "./deployed");

      if (!saved && !opts.port && !opts.dataDir && !opts.foreground) {
        console.log(`Using defaults (port: ${port}, data-dir: ${dataDir}). Run \`openagent server setup\` to configure.`);
      }

      if (!opts.foreground) {
        const args = [
          "bun",
          process.argv[1],
          "server",
          "start",
          "--foreground",
          "--port",
          String(port),
          "--data-dir",
          dataDir,
        ];

        const proc = Bun.spawn(args as string[], {
          stdio: ["ignore", "ignore", "ignore"],
          detached: true,
        });

        const pidPath = resolve("openagent.pid");
        await Bun.write(pidPath, String(proc.pid));

        console.log(`openagent server started (pid: ${proc.pid})`);
        console.log(`  port:     ${port}`);
        console.log(`  data-dir: ${dataDir}`);
        console.log(`  pid file: ${pidPath}`);
        proc.unref();
        process.exit(0);
      }

      process.env.OPENAGENT_LOG_DIR = resolve(dataDir, "logs");

      const { createServer } = await import("../server/index.ts");
      const { app, shutdown } = await createServer(dataDir);

      console.log(`openagent server listening on port ${port}`);
      console.log(`  data-dir: ${dataDir}`);
      console.log(`  logs:     ${process.env.OPENAGENT_LOG_DIR}`);

      Bun.serve({
        port,
        fetch: app.fetch,
      });

      const pidPath = resolve("openagent.pid");
      let isShuttingDown = false;

      async function gracefulShutdown(trigger: string) {
        if (isShuttingDown) return;
        isShuttingDown = true;

        const forceExit = setTimeout(() => {
          console.error("[openagent] Graceful shutdown timed out after 10s, forcing exit");
          process.exit(1);
        }, 10_000);
        forceExit.unref();

        try {
          shutdown();
        } catch (err) {
          console.error("[openagent] Error during shutdown:", err);
        }

        try {
          const { unlink } = await import("fs/promises");
          await unlink(pidPath);
        } catch {}

        console.log(`[openagent] Server stopped (trigger: ${trigger})`);
        process.exit(0);
      }

      process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
      process.on("SIGINT", () => gracefulShutdown("SIGINT"));

      process.on("uncaughtException", (err) => {
        console.error("[openagent] Uncaught exception:", err);
        gracefulShutdown("uncaughtException");
      });

      process.on("unhandledRejection", (reason) => {
        console.error("[openagent] Unhandled rejection:", reason);
        gracefulShutdown("unhandledRejection");
      });
    });

  serverCmd
    .command("stop")
    .description("Stop the running openagent server")
    .action(async () => {
      const pidPath = resolve("openagent.pid");
      const pidFile = Bun.file(pidPath);

      if (!(await pidFile.exists())) {
        console.error("No PID file found. Is the server running?");
        process.exit(1);
      }

      const pid = parseInt(await pidFile.text());

      try {
        process.kill(pid, "SIGTERM");
        console.log(`Sent SIGTERM to process ${pid}`);
        const { unlink } = await import("fs/promises");
        await unlink(pidPath);
      } catch (err: any) {
        if (err.code === "ESRCH") {
          console.log(`Process ${pid} is not running. Cleaning up PID file.`);
          const { unlink } = await import("fs/promises");
          await unlink(pidPath);
        } else {
          console.error(`Failed to stop server: ${err.message}`);
          process.exit(1);
        }
      }
    });

  serverCmd
    .command("status")
    .description("Check server status")
    .action(async () => {
      const pidPath = resolve("openagent.pid");
      const pidFile = Bun.file(pidPath);

      if (!(await pidFile.exists())) {
        console.log("Server is not running (no PID file)");
        return;
      }

      const pid = parseInt(await pidFile.text());

      try {
        process.kill(pid, 0);
        console.log(`Server is running (pid: ${pid})`);
      } catch {
        console.log(`Server is not running (stale PID file, pid was: ${pid})`);
      }
    });

  serverCmd
    .command("logs")
    .description("View server logs")
    .option("-f, --follow", "Follow log output (like tail -f)")
    .option("-n, --lines <count>", "Number of recent lines to show", "50")
    .option("--raw", "Show raw JSON instead of pretty-printing")
    .option("-d, --data-dir <dir>", "Data directory")
    .action(async (opts) => {
      const config = await loadAppConfig();
      const dataDir = resolve(opts.dataDir || config.serverConfig?.dataDir || "./deployed");
      const logFile = resolve(dataDir, "logs", "server.log");

      if (!(await Bun.file(logFile).exists())) {
        console.error(`No log file found at ${logFile}`);
        console.error("Make sure the server has been started at least once.");
        process.exit(1);
      }

      const tailArgs = ["-n", opts.lines];
      if (opts.follow) tailArgs.push("-f");
      tailArgs.push(logFile);

      const tail = Bun.spawn(["tail", ...tailArgs], { stdout: opts.raw ? "inherit" : "pipe" });

      if (!opts.raw) {
        const prettyBin = resolve(import.meta.dir, "..", "node_modules", ".bin", "pino-pretty");
        const pretty = Bun.spawn([prettyBin, "--colorize"], {
          stdin: tail.stdout!,
          stdout: "inherit",
        });
        await pretty.exited;
      } else {
        await tail.exited;
      }
    });

  serverCmd
    .command("setup")
    .description("Configure default server settings (port, data directory)")
    .option("-p, --port <port>", "Port to listen on")
    .option("-d, --data-dir <dir>", "Directory for deployed graphs")
    .action(async (opts) => {
      const config = await loadAppConfig();
      const existing = config.serverConfig;

      let port: number;
      let dataDir: string;

      if (opts.port && opts.dataDir) {
        port = parseInt(opts.port);
        dataDir = resolve(opts.dataDir);
      } else {
        p.intro("Server configuration");

        const answers = await p.group({
          port: () =>
            p.text({
              message: "Port to listen on",
              placeholder: String(existing?.port ?? 3000),
              defaultValue: String(existing?.port ?? 3000),
              validate: (v) => (!v || isNaN(parseInt(v)) ? "Must be a number" : undefined),
            }),
          dataDir: () =>
            p.text({
              message: "Directory for deployed graphs",
              placeholder: existing?.dataDir ?? "./deployed",
              defaultValue: existing?.dataDir ?? "./deployed",
            }),
        }, {
          onCancel: () => { p.cancel("Operation cancelled."); process.exit(0); },
        });

        port = parseInt(answers.port);
        dataDir = resolve(answers.dataDir);
      }

      config.serverConfig = { port, dataDir };
      await saveAppConfig(config);
      console.log(`Server config saved:`);
      console.log(`  port:     ${port}`);
      console.log(`  data-dir: ${dataDir}`);
    });
}
