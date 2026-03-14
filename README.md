# OpenAgent

A CLI and server for deploying, managing, and running [LangGraph](https://langchain-ai.github.io/langgraphjs/) workflows as services. Deploy your AI agent graphs to a server and trigger them via webhooks, Telegram, cron schedules, or graph-to-graph chaining.

## Features

- **Deploy LangGraph workflows** — bundle and deploy `.ts`/`.js` graphs to a remote (or local) server
- **Multiple trigger channels** — invoke graphs via HTTP webhooks, Telegram bot, cron schedules, or when another graph completes
- **Job queue** — SQLite-backed queue with concurrency control, per-thread serialization, automatic retries, and job batching
- **Environment management** — set and encrypt per-graph environment variables
- **Multi-server profiles** — manage connections to multiple OpenAgent servers from one CLI
- **Daemon mode** — run the server as a background process with log tailing

## Prerequisites

- [Bun](https://bun.sh) v1.3+

## Installation

```bash
git clone <repo-url> && cd open-agent-v2
bun install
bun link  # makes `openagent` available globally
```

## Quick Start

**1. Start the server**

```bash
openagent server start
```

By default, the server runs on port `3000` with data stored in `./deployed`. Use `--port` and `--data-dir` to customize, or run `openagent server setup` to configure interactively.

**2. Configure a client profile**

```bash
openagent client setup local http://localhost:3000
```

**3. Deploy a workflow**

```bash
openagent client start ./workflows/examples/basic-agent-with-store/debug.ts -n my-agent
```

This bundles the workflow, uploads it to the server, and activates it.

**4. Add a channel**

```bash
openagent client channels add
```

Follow the interactive prompts to attach a webhook, Telegram bot, cron trigger, or graph chain to your deployed graph.

## CLI Reference

### Server Commands

| Command | Description |
|---|---|
| `openagent server start` | Start the server (daemon by default, `--foreground` for attached) |
| `openagent server stop` | Stop the running server |
| `openagent server status` | Check if the server is running |
| `openagent server logs` | Tail server logs (`-f` to follow, `-n` for line count) |
| `openagent server setup` | Configure port and data directory |

### Client Commands

| Command | Description |
|---|---|
| `openagent client setup [name] [url]` | Add or update a server profile |
| `openagent client connect [name]` | Switch active server |
| `openagent client status` | Show servers and health |
| `openagent client graphs` | List deployed graphs |
| `openagent client start [file]` | Deploy a workflow file or activate an existing graph |
| `openagent client stop [name]` | Deactivate a graph |
| `openagent client remove [name]` | Remove a graph from the server |

### Environment Commands

| Command | Description |
|---|---|
| `openagent client env set [name] [KEY=VAL ...]` | Set env vars (supports `.env` files) |
| `openagent client env list [name]` | List env vars (values masked) |

### Channel Commands

| Command | Description |
|---|---|
| `openagent client channels list` | List all channels |
| `openagent client channels add` | Create a channel (interactive) |
| `openagent client channels remove [id]` | Remove a channel |
| `openagent client channels start [id]` | Activate a channel |
| `openagent client channels stop [id]` | Deactivate a channel |

## Architecture

```
                        ┌──────────────────────────────────────────┐
                        │              Trigger Channels            │
                        ├──────────┬──────────┬────────┬───────────┤
                        │ Webhook  │ Telegram │  Cron  │   Graph   │
                        └────┬─────┴────┬─────┴───┬────┴─────┬─────┘
                             └──────────┴─────────┴──────────┘
                                            │
                                            ▼
                                   ChannelManager
                                    invokeGraph()
                                            │
                                            ▼
                                      GraphQueue
                                  (SQLite, concurrency,
                                   retries, batching)
                                            │
                                            ▼
                                     GraphRegistry
                                   getGraphInstance()
                                            │
                                            ▼
                                    graph.invoke(input)
                                      (LangGraph)
```

### Server

The server is a [Hono](https://hono.dev)-based HTTP app. It exposes REST endpoints for graph and channel management, plus ingress routes (`/hooks/:id`, `/hooks/telegram/:id`) that receive external events without API key auth.

### Graph Registry

Persists deployed graph metadata to `registry.json`. Tracks graph name, file path, active state, exported entry points, and encrypted environment variables. Holds in-memory `CompiledGraph` instances for invocation.

### Job Queue

An SQLite-backed queue that processes graph invocations with:
- **Concurrency** — configurable max parallel runs (default: 5)
- **Thread affinity** — jobs for the same `thread_id` run sequentially
- **Batching** — multiple pending jobs for the same graph+thread are merged
- **Retries** — failed jobs retry up to a configurable limit (default: 2)
- **Retention** — completed jobs are cleaned up after a configurable period

### Channel Types

| Type | Trigger | Config |
|---|---|---|
| **webhook** | `POST /hooks/:id` with JSON body | Optional HMAC secret for signature verification |
| **telegram** | Telegram bot webhook | Bot token; auto-registers/deregisters webhook with Telegram API |
| **cron** | Cron schedule | Cron expression + static input payload |
| **graph** | Another graph completes | Source graph name; receives the completed graph's output |

## Writing Workflows

Workflows are standard LangGraph `StateGraph` definitions. Export either a compiled graph directly or a `builder(env)` function that returns one:

```typescript
// builder.ts
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

export function builder(env: Record<string, string>) {
  const model = new ChatOpenAI({
    modelName: "gpt-4o",
    apiKey: env.OPENAI_API_KEY,
  });

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", async (state) => {
      const response = await model.invoke(state.messages);
      return { messages: [response] };
    })
    .addEdge("__start__", "agent")
    .compile();

  return graph;
}
```

```typescript
// debug.ts — local development entry point
import "dotenv/config";
import { builder } from "./builder";

export const graph = builder(process.env as Record<string, string>);
```

The `builder(env)` pattern allows the server to inject per-graph environment variables at deploy time, while `debug.ts` loads from a local `.env` file for development.

### Local Development

Use the LangGraph CLI for local workflow development with hot reload:

```bash
bunx @langchain/langgraph-cli dev
```

Configure graphs in `langgraph.json`.

## HTTP API

All `/api/*` endpoints require an `X-API-Key` header when `API_KEY` is set.

### Graphs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/graphs` | List all graphs |
| `GET` | `/api/graphs/:name` | Get graph details |
| `POST` | `/api/graphs/deploy` | Deploy bundled code (`{ name, code, env? }`) |
| `POST` | `/api/graphs/:name/start` | Activate a graph |
| `POST` | `/api/graphs/:name/stop` | Deactivate a graph |
| `GET` | `/api/graphs/:name/env` | List env vars (masked) |
| `PUT` | `/api/graphs/:name/env` | Set env vars |
| `DELETE` | `/api/graphs/:name` | Remove a graph |

### Channels

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/channels` | List channels (filter with `?graph=name`) |
| `GET` | `/api/channels/:id` | Get channel details |
| `POST` | `/api/channels` | Create a channel |
| `PUT` | `/api/channels/:id` | Update channel config |
| `DELETE` | `/api/channels/:id` | Remove a channel |
| `POST` | `/api/channels/:id/start` | Activate a channel |
| `POST` | `/api/channels/:id/stop` | Deactivate a channel |

### Ingress (no auth)

| Method | Path | Description |
|---|---|---|
| `POST` | `/hooks/:id` | Webhook ingress |
| `POST` | `/hooks/telegram/:id` | Telegram webhook ingress |

### Other

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/api/queue/stats` | Queue statistics |

## Configuration

### Server Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_KEY` | — | API key for authenticating `/api/*` requests |
| `OPENAGENT_ENCRYPTION_KEY` | — | Key for decrypting client-encrypted env vars |
| `OPENAGENT_LOG_DIR` | — | Log file directory (set automatically by `server start`) |
| `LOG_LEVEL` | `info` | Pino log level |
| `LOG_MAX_SIZE` | — | Max log file size in bytes |
| `LOG_RETENTION_DAYS` | — | Log retention period |
| `MAX_CONCURRENT_RUNS` | `5` | Max parallel graph invocations |
| `MAX_JOB_RETRIES` | `2` | Max retry attempts for failed jobs |
| `JOB_RETENTION_HOURS` | `24` | Hours to keep completed jobs |

### Client Config

Stored at `~/.openagent/config.json`. Manages server profiles (URL, API key, encryption key) and local server settings (port, data directory).

## Project Structure

```
├── cli.ts                          # CLI entry point
├── cli/
│   ├── server.ts                   # Server management commands
│   ├── client.ts                   # Client commands (deploy, manage)
│   ├── channels.ts                 # Channel management commands
│   ├── env.ts                      # Environment variable commands
│   ├── config.ts                   # Config file management
│   └── prompts.ts                  # Interactive prompts
├── server/
│   ├── index.ts                    # Server bootstrap
│   ├── loader.ts                   # Dynamic graph loading
│   ├── registry.ts                 # Graph registry (JSON persistence)
│   ├── queue.ts                    # SQLite job queue
│   ├── middleware.ts               # HTTP logging & auth
│   ├── logger.ts                   # Pino logger
│   ├── routes/
│   │   ├── graphs.ts               # Graph API routes
│   │   └── channels.ts             # Channel API + ingress routes
│   └── channels/
│       ├── manager.ts              # Channel lifecycle management
│       ├── types.ts                # Channel type definitions
│       └── handlers/
│           ├── webhook.ts          # Webhook handler (HMAC support)
│           ├── telegram.ts         # Telegram bot handler
│           └── cron.ts             # Cron scheduler
├── lib/
│   └── crypto.ts                   # AES-256-GCM encryption
├── tools/                          # LangChain tools for workflows
│   ├── shell.ts
│   ├── readFile.ts
│   └── writeFile.ts
└── workflows/examples/             # Example workflows
    ├── basic-agent-with-store/     # Agent with Postgres checkpointing
    └── linear-assistant/           # Linear PM assistant via MCP
```

## License

Private
