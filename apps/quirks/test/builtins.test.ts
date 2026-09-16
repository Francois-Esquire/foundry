import { InMemorySessionStore } from "@foundry/agents/session";
import { directory, WorkspaceSystem } from "@foundry/workspaces";
import { Git, git } from "@foundry/workspaces/git";
import { describe, expect, it } from "vitest";
import { bindAgents } from "~/agents";
import {
  develop,
  findingsIn,
  reviewInWorktree,
  reviewSession,
} from "~/builtins";
import { CLAUDE_CODE, CODEX } from "~/harnesses";
import { registry } from "~/lib/registry";
import type { Reply } from "~/models/echo";
import { mockModels } from "~/models/echo";
import { echoGit } from "~/runtime";

import { seedRepository } from "./helpers/repository";

const executors = [CLAUDE_CODE, CODEX];

interface BindOptions {
  /** Run git for real; the default echoes every mutation. */
  readonly live?: boolean;
  readonly log?: (line: string) => void;
}

function bind(reply: Reply, options: BindOptions = {}) {
  const models = mockModels(executors, reply);
  const sessions = new InMemorySessionStore();
  const catalogue = new WorkspaceSystem().extend(
    directory(),
    git(options.live ? {} : { run: echoGit(() => undefined) })
  );
  registry.bind({
    agents: bindAgents({
      executors,
      models,
      sessions,
      skills: () => Promise.resolve([]),
    }),
    executors,
    log: options.log ?? (() => undefined),
    models,
    sessions,
    workspace: { root: process.cwd() },
    workspaces: {
      add: (input) => catalogue.add(input),
      git: (root) =>
        Git.at(root, options.live ? {} : { run: echoGit(() => undefined) }),
    },
  });
  return sessions;
}

/** Reviews (the second harness) reject until `rounds`, then pass. */
function reviewsAfter(rounds: number): Reply {
  let seen = 0;
  return ({ executor }) => {
    if (executor === CLAUDE_CODE) {
      return "did the work";
    }
    seen += 1;
    return seen >= rounds ? "PASS" : "still missing a test";
  };
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

describe("develop", () => {
  const input = {
    cwd: "/tmp/nowhere",
    findings: [],
    round: 1,
    task: "add a health endpoint",
  };

  it("loops until a review passes", async () => {
    bind(reviewsAfter(3));
    const result = await develop.create().run(input);
    expect(result).toMatchObject({ rounds: 3, settled: true });
    expect(result.output.findings).toEqual([]);
  });

  it("gives up unsettled when reviews never pass", async () => {
    bind(reviewsAfter(99));
    const result = await develop.create().run(input);
    expect(result).toMatchObject({ rounds: 5, settled: false });
    expect(result.output.findings).toEqual(["still missing a test"]);
  });
});

describe("reviewInWorktree", () => {
  it("asks every harness inside the worktree", async () => {
    const lines: string[] = [];
    bind(({ executor, cwd }) => `${executor.harness} saw ${cwd ?? "nothing"}`, {
      log: (line) => lines.push(line),
    });
    const result = await reviewInWorktree
      .create()
      .run({ base: "HEAD", repository: "/repo" });
    expect(result.reviews.map((review) => review.harness)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(result.reviews[0]?.text).toBe(`claude-code saw ${result.root}`);
    expect(lines[1]).toBe(`[worktree] ${result.root}: no git`);
  });

  it("logs a real worktree's git state without cataloguing it", async () => {
    const repository = await seedRepository();
    const lines: string[] = [];
    bind(() => "PASS", {
      live: true,
      log: (line) => lines.push(line),
    });
    const result = await reviewInWorktree
      .create()
      .run({ base: "main", repository });
    expect(result.reviews).toHaveLength(2);
    expect(lines[1]).toBe(
      `[worktree] ${result.root}: detached at main · clean`
    );
  });
});

describe("reviewSession", () => {
  const input = { base: "main", repository: "/repo" };

  it("confines the session's turn to the worktree", async () => {
    const lines: string[] = [];
    bind(({ cwd }) => `saw ${cwd ?? "nothing"}`, {
      log: (line) => lines.push(line),
    });
    const result = await reviewSession.create().run(input);
    const root = lines[0]?.replace(/^reviewing in (.*) as review-main$/, "$1");
    expect(result).toEqual({
      sessionId: "review-main",
      text: `saw ${root ?? ""}`,
    });
  });

  it("keeps the review under one session across runs", async () => {
    const sessions = bind(() => "looks fine");
    await reviewSession.create().run(input);
    await reviewSession.create().run(input);
    const messages = await sessions.listMessages("review-main");
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });
});
