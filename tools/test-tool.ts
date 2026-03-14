import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const testTool = tool(
  async ({ tool_response }) => {
    return { tool_response: "Hello, world!" };
  },
  {
    name: "test_tool",
    description: "Test tool",
    schema: z.object({}),
  },
);
