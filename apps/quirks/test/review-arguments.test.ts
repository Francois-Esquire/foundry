import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CODEX } from "~/harnesses";
import { registry } from "~/lib/registry";
import { mockModels } from "~/models/echo";
import { bindRuntime, type Runtime } from "~/runtime";
import { reviewWithArguments } from "../examples/review-with-arguments";

const review = reviewWithArguments();
let root: string;
let checkout: string;
let runtime: Runtime;
let calls: { cwd: string | undefined; prompt: string }[] = [];

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "quirks-review-")));
  checkout = join(root, "another-checkout");
  await mkdir(join(checkout, "src"), { recursive: true });
  // Linked worktrees have a .git file instead of a directory.
  await writeFile(join(checkout, ".git"), "gitdir: /unused-in-this-test\n");
  runtime = bindRuntime({ dry: true, only: [], print: () => undefined, root });
  registry.bind({
    ...runtime.primitives,
    executors: [CODEX],
    models: mockModels([CODEX], (call) => {
      calls.push(call);
      return "No supported findings in the inspected files.";
    }),
  });
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { force: true, recursive: true });
});

it("runs in the selected checkout and carries choices, notes, numbers, and false toggles to the model", async () => {
  calls = [];
  const result = await review.create().run({
    focus: "Check cancellation",
    includeTests: false,
    maxFindings: 2,
    scope: "staged",
    security: true,
    target: "src",
    worktree: "another-checkout",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.cwd).toBe(checkout);
  expect(calls[0]?.prompt).toContain("Review only staged changes");
  expect(calls[0]?.prompt).toContain("Check cancellation");
  expect(calls[0]?.prompt).toContain("at most 2 concrete findings");
  expect(calls[0]?.prompt).toContain("Do not inspect test files");
  expect(calls[0]?.prompt).toContain("Include a security pass");
  expect(result).toMatchObject({
    harness: "codex",
    target: "src",
    worktree: checkout,
  });
});

it("rejects a target outside the checkout before calling a model", async () => {
  calls = [];
  await expect(
    review.create().run({ target: "..", worktree: "another-checkout" })
  ).rejects.toThrow("inside the selected worktree");
  expect(calls).toHaveLength(0);
});

it("validates arguments from once as well as the form", async () => {
  calls = [];
  await expect(
    review.create().run({ maxFindings: 2.5, worktree: "another-checkout" })
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
