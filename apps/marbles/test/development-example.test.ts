import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { catalog } from "~/authoring/catalog";
import type { Reply } from "~/lib/models/echo";
import {
  developRound,
  findingsIn,
  reviewInWorktree,
  reviewSession,
} from "../examples/development";

import type { MockBindingOptions, MockBindings } from "./helpers/bindings";
import { bindMock } from "./helpers/bindings";
import { launch } from "./helpers/launch";
import { seedRepository } from "./helpers/repository";

type Call = Parameters<Reply>[0];

const WORKTREE_DIR = /^worktree-/;

let mock: MockBindings | undefined;
const repositories: string[] = [];

afterEach(async () => {
  catalog.reset();
  await mock?.dispose();
  mock = undefined;
  await Promise.all(
    repositories
      .splice(0)
      .map((repository) => rm(repository, { force: true, recursive: true }))
  );
});

function bind(reply: Reply, options: MockBindingOptions = {}) {
  mock = bindMock(reply, options);
  return mock;
}

async function freshRepository() {
  const root = await seedRepository();
  repositories.push(root);
  return root;
}

/** Both agents share the default provider; the system prompt tells them apart. */
function isReview(call: Call) {
  return call.prompt.includes("You review code");
}

describe("findingsIn", () => {
  it("reads PASS on its own line as clean, whatever surrounds it", () => {
    expect(findingsIn("Looks good.\nPASS\n")).toEqual([]);
  });

  it("takes every non-empty line as a finding otherwise", () => {
    expect(findingsIn("no tests\n\n  naming is off  ")).toEqual([
      "no tests",
      "naming is off",
    ]);
  });
});

describe("developRound", () => {
  const input = { cwd: "/tmp/nowhere", task: "add a health endpoint" };

  it("implements, then reviews the report in the same directory", async () => {
    const calls: Call[] = [];
    bind((call) => {
      calls.push(call);
      return isReview(call) ? "PASS" : "did the work";
    });
    const result = await launch(developRound, input);
    expect(result).toEqual({ findings: [], text: "PASS" });
    expect(calls.map((call) => call.cwd)).toEqual([
      "/tmp/nowhere",
      "/tmp/nowhere",
    ]);
    expect(calls[0]?.prompt).toContain("add a health endpoint");
    expect(calls[1]?.prompt).toContain(
      "The implementer reported:\ndid the work"
    );
  });

  it("reports the findings when the review does not pass", async () => {
    bind((call) => (isReview(call) ? "still missing a test" : "did the work"));
    await expect(launch(developRound, input)).resolves.toEqual({
      findings: ["still missing a test"],
      text: "still missing a test",
    });
  });
});

describe("reviewInWorktree", () => {
  it("opens the session inside a worktree and removes it afterwards", async () => {
    const lines: string[] = [];
    bind(({ cwd }) => `saw ${cwd ?? "nothing"}`, {
      live: true,
      log: (line) => lines.push(line),
    });
    const result = await launch<{ review: string; root: string }>(
      reviewInWorktree,
      { base: "main", repository: await freshRepository() }
    );
    expect(result.root).not.toBe(repositories[0]);
    expect(lines).toEqual([`reviewing in ${result.root}`]);
    expect(result.review).toBe(`saw ${result.root}`);
    expect(existsSync(result.root)).toBe(false);
  });
});

describe("reviewSession", () => {
  it("confines the session's turn to the worktree", async () => {
    const calls: Call[] = [];
    bind(
      (call) => {
        calls.push(call);
        return `saw ${call.cwd ?? "nothing"}`;
      },
      { live: true }
    );
    const result = await launch(reviewSession, {
      base: "main",
      repository: await freshRepository(),
    });
    expect(calls).toHaveLength(1);
    // The turn ran in the temporary worktree, not the repository itself.
    expect(basename(calls[0]?.cwd ?? "")).toMatch(WORKTREE_DIR);
    expect(calls[0]?.cwd).not.toBe(repositories[0]);
    expect(result).toEqual({
      sessionId: "review-main",
      text: `saw ${calls[0]?.cwd ?? ""}`,
    });
  });

  it("keeps the review under one session across runs", async () => {
    const { sessions } = bind(() => "looks fine", { live: true });
    const input = { base: "main", repository: await freshRepository() };
    await launch(reviewSession, input);
    await launch(reviewSession, input);
    const messages = await sessions.listMessages("review-main");
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});
