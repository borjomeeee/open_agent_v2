import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const readFileTool = tool(
  async ({ path }) => {
    return Bun.file(path).text();
  },
  {
    name: "readFile",
    description: "Read a file and return the content",
    schema: z.object({
      path: z.string().describe("The path to the file to read"),
    }),
  },
);