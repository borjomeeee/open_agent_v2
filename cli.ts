#!/usr/bin/env bun

import { Command } from "commander";
import { registerServerCommands } from "./cli/server.ts";
import { registerClientCommands } from "./cli/client.ts";

const program = new Command();

program
  .name("openagent")
  .description("CLI for serving and deploying LangGraph workflows")
  .version("0.1.0");

registerServerCommands(program);
registerClientCommands(program);

program.parse();
