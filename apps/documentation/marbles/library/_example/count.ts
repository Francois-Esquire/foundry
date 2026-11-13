import { step } from "@foundry.sh/marbles";
import { z } from "zod";

// The same module works three ways: `marbles roll count`, an embedded
// engine (./standalone.ts), and the MCP server's `dispatch_workflow`.
export const count = step("count")
  .input(z.object({ extension: z.string() }))
  .do(async ({ input, workspaces }) => {
    const files = await workspaces.current.files();
    return {
      extension: input.extension,
      files: files.filter((file) => file.path.endsWith(input.extension)).length,
    };
  });
