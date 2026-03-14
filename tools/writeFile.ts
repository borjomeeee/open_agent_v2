import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const writeFileTool = tool(  
  async ({ path, content }) => {
    return Bun.file(path).write(content);
  },
  {
    name: "writeFile",
    description: "Write a file and return the content",
    schema: z.object({
      path: z.string().describe("The path to the file to write"),
      content: z.string().describe("The content to write to the file"),
    }),
  },
);