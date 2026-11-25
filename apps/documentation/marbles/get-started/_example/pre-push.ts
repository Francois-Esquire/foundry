import { agent, step, workflow } from "@foundry.sh/marbles";
import { z } from "zod";

const command = z.object({ exitCode: z.number(), stderr: z.string() });

const lint = step("lint").exec("bun run lint", { check: false });
const tests = step("tests").exec("bun test", { check: false });

const reviewer = agent({
  name: "diff-reviewer",
  prompt:
    "Review the uncommitted changes in this repository. Report concrete findings with file references. Do not edit files.",
});

const review = step("review").do(
  async () =>
    (await reviewer.generate("Review the output of `git diff HEAD`.")).text
);

const verdict = step("verdict")
  .input(z.object({ lint: command, review: z.string(), tests: command }))
  .do(({ input }) => ({
    lint: input.lint.exitCode === 0,
    review: input.review,
    tests: input.tests.exitCode === 0,
  }));

workflow("pre-push", () =>
  verdict.parallel({ lint: lint(), review: review(), tests: tests() })
);
