import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { catalog } from "~/lib/catalog";
import { CODEX } from "~/lib/harnesses";
import type { Reply } from "~/lib/models/echo";
import { runs } from "~/lib/run-scope";
import { reviewWorktree as review } from "../examples/review-with-arguments";

import type { MockBindings } from "./helpers/bindings";
import { bindMock } from "./helpers/bindings";
import { launch } from "./helpers/launch";

let root: string;
let checkout: string;
let mock: MockBindings;
let calls: Parameters<Reply>[0][] = [];

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "quirks-review-")));
  checkout = join(root, "another-checkout");
  await mkdir(join(checkout, "src"), { recursive: true });
  // Linked worktrees have a .git file instead of a directory.
  await writeFile(join(checkout, ".git"), "gitdir: /unused-in-this-test\n");
  mock = bindMock(
    (call) => {
      calls.push(call);
      return "No supported findings in the inspected files.";
    },
    { executors: [CODEX], root }
  );
});

afterAll(async () => {
  await mock.dispose();
  catalog.reset();
  runs.clear();
  await rm(root, { force: true, recursive: true });
});

it("describes its arguments as launch-form fields from the schema", () => {
  const entry = catalog
    .entries()
    .find((item) => item.name === "review-worktree");
  expect(entry?.kind).toBe("step");
  expect(entry?.input.fields.map((field) => [field.name, field.type])).toEqual([
    ["focus", "text"],
    ["includeTests", "boolean"],
    ["maxFindings", "number"],
    ["scope", "select"],
    ["security", "boolean"],
    ["target", "text"],
    ["worktree", "text"],
  ]);
});

it("runs in the selected checkout and carries choices, notes, numbers, and false toggles to the model", async () => {
  calls = [];
  const result = await launch(review, {
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
    provider: "codex",
    target: "src",
    worktree: checkout,
  });
});

it("rejects a target outside the checkout before calling a model", async () => {
  calls = [];
  await expect(
    launch(review, { target: "..", worktree: "another-checkout" })
  ).rejects.toThrow("inside the selected worktree");
  expect(calls).toHaveLength(0);
});

it("validates arguments from once as well as the form", async () => {
  calls = [];
  await expect(
    launch(review, { maxFindings: 2.5, worktree: "another-checkout" })
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
