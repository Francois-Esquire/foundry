import { step } from "@foundry.sh/marbles";
import { z } from "zod";

export const count = step("count")
  .input(z.object({ extension: z.string() }))
  .do(async ({ input, workspaces }) => {
    const files = await workspaces.current.files();
    return {
      extension: input.extension,
      files: files.filter((file) => file.path.endsWith(input.extension)).length,
    };
  });
