import { tool } from "@langchain/core/tools";
import { promisify } from "util";
import { exec } from "child_process";
import { z } from "zod";

const execAsync = promisify(exec);

export const shellTool = tool(
  async ({ command, timeout_ms }) => {
    const result = await execAsync(command, {
      cwd: process.cwd(),
      timeout: timeout_ms ?? undefined,
    });
    return result.stdout + result.stderr;
  },
  {
    name: "shell",
    description: "Execute bash command and return the output",
    schema: z.object({
      command: z.string().describe("The command to execute"),
      timeout_ms: z.number().describe("The timeout in milliseconds"),
    }),
  },
);
