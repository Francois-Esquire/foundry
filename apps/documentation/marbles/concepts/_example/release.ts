import { step } from "@foundry.sh/marbles";
import { z } from "zod";

step("release")
  .input(z.object({ ref: z.string() }))
  .do(async ({ input, exec, log }) => {
    const resolved = await exec(["git", "rev-parse", "--verify", input.ref]);
    const commit = resolved.stdout.trim();
    const { id, result } = await step.enqueue<{ commit: string; ok: boolean }>(
      "package-build",
      { commit },
      { key: `package-build:${commit}` }
    );
    log("Building", commit, "in run", id);
    const build = await result;
    return { build: id, released: build.ok };
  });
