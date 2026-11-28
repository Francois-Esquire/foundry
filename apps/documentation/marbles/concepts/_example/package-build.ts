import { step } from "@foundry.sh/marbles";
import { z } from "zod";

step("package-build")
  .input(z.object({ commit: z.string() }))
  .do(async ({ input, exec }) => {
    const built = await exec(["bun", "run", "build"], { check: false });
    return { commit: input.commit, ok: built.exitCode === 0 };
  });
