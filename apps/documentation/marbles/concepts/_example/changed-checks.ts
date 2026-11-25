import { step, workflow } from "@foundry.sh/marbles";
import { z } from "zod";

const target = z.object({ dir: z.string() });
const exit = z.object({ exitCode: z.number() });

const lint = step("lint-in")
  .input(target)
  .exec("bun run lint", ({ input }) => ({ check: false, cwd: input.dir }));

const tests = step("tests-in")
  .input(target)
  .exec("bun test", ({ input }) => ({ check: false, cwd: input.dir }));

const verdict = step("checks-verdict")
  .input(target.extend({ lint: exit, tests: exit }))
  .do(({ input }) => input.lint.exitCode === 0 && input.tests.exitCode === 0);

const checks = workflow("checks-in")
  .input(target)
  .do(({ input }) =>
    verdict.parallel({ lint: lint({}, input), tests: tests({}, input) }, input)
  );

const changedPackage = step("changed-package").do(async ({ exec }) => {
  const diff = await exec(["git", "diff", "--name-only", "HEAD~1"]);
  const path = diff.stdout
    .split("\n")
    .find((file) => file.startsWith("packages/"));
  return path ? path.split("/").slice(0, 2).join("/") : ".";
});

workflow("check-changed", () => checks({ dir: changedPackage() }));
