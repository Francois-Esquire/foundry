import { describe, expect, it } from "vitest";

import { RunScope } from "~/lib/run-scope";
import { StepInputError } from "~/lib/step-work";

const NO_TURN_PATTERN = /no agent turn is running in "flow.review"/;

function scope(id = "run-1") {
  return new RunScope(id, "/tmp/project");
}

function codeOf(work: () => void): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof StepInputError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}

describe("live work in a step", () => {
  it("lists what is live in each step under the step that owns it", () => {
    const run = scope();
    const review = run.frame(["flow", "review"]);
    const build = run.frame(["flow", "review", "build"]);
    review.work.begin({
      kind: "agent",
      model: "sonnet",
      provider: "claude-code",
      sessionId: "session-1",
      steer: () => undefined,
    });
    build.work.begin({ command: "npm test", kind: "command" });
    expect(run.work()).toEqual([
      {
        id: expect.any(String),
        input: "steer",
        kind: "agent",
        model: "sonnet",
        provider: "claude-code",
        sessionId: "session-1",
        stepId: "flow.review",
      },
      {
        command: "npm test",
        id: expect.any(String),
        input: "none",
        kind: "command",
        stepId: "flow.review.build",
      },
    ]);
  });

  it("delivers a line to the command it names and to nothing once that work ends", () => {
    const run = scope();
    const frame = run.frame(["flow", "build"]);
    const lines: string[] = [];
    const end = frame.work.begin({
      command: "read name",
      kind: "command",
      stdin: (line) => lines.push(line),
    });
    const [live] = run.work();
    run.send("flow.build", { target: live?.id ?? "", text: "Ada" });
    expect(lines).toEqual(["Ada"]);
    end();
    expect(run.work()).toEqual([]);
    expect(
      codeOf(() =>
        run.send("flow.build", { target: live?.id ?? "", text: "x" })
      )
    ).toBe("not-live");
    expect(lines).toEqual(["Ada"]);
  });

  it("refuses input aimed at work through another step, another run, or a later attempt", () => {
    const first = scope("run-1");
    const second = scope("run-2");
    const lines: string[] = [];
    const frame = first.frame(["flow", "build"]);
    first.frame(["flow", "lint"]);
    const nested = first.frame(["flow", "build", "inner"]);
    nested.work.begin({
      command: "inner",
      kind: "command",
      stdin: (line) => lines.push(`inner:${line}`),
    });
    const end = frame.work.begin({
      command: "outer",
      kind: "command",
      stdin: (line) => lines.push(`outer:${line}`),
    });
    const outer = first.work().find((work) => work.stepId === "flow.build");
    const inner = first
      .work()
      .find((work) => work.stepId === "flow.build.inner");
    const target = outer?.id ?? "";
    expect(codeOf(() => first.send("flow.lint", { target, text: "x" }))).toBe(
      "not-live"
    );
    expect(codeOf(() => second.send("flow.build", { target, text: "x" }))).toBe(
      "not-live"
    );
    expect(
      codeOf(() =>
        first.send("flow.build", { target: inner?.id ?? "", text: "x" })
      )
    ).toBe("not-live");
    end();
    frame.work.begin({
      command: "outer",
      kind: "command",
      stdin: (line) => lines.push(`retry:${line}`),
    });
    expect(codeOf(() => first.send("flow.build", { target, text: "x" }))).toBe(
      "not-live"
    );
    expect(lines).toEqual([]);
  });

  it("says when the named work takes no input instead of dropping it", () => {
    const run = scope();
    run.frame(["flow", "remote"]).work.begin({
      command: "make",
      kind: "command",
    });
    const [live] = run.work();
    expect(
      codeOf(() =>
        run.send("flow.remote", { target: live?.id ?? "", text: "y" })
      )
    ).toBe("no-input");
  });

  it("refuses a step it never opened", () => {
    expect(
      codeOf(() => scope().send("flow.nowhere", { target: "x", text: "y" }))
    ).toBe("not-live");
  });

  it("steers the one agent turn in a step and refuses to pick among several", () => {
    const run = scope();
    const frame = run.frame(["flow", "review"]);
    expect(() => run.steer("flow.review", "focus")).toThrow(NO_TURN_PATTERN);
    const steered: string[] = [];
    const first = frame.work.begin({
      kind: "agent",
      sessionId: "session-1",
      steer: (prompt) => steered.push(`one:${prompt}`),
    });
    frame.work.begin({ command: "npm test", kind: "command" });
    run.steer("flow.review", "focus");
    expect(steered).toEqual(["one:focus"]);
    frame.work.begin({
      kind: "agent",
      sessionId: "session-2",
      steer: (prompt) => steered.push(`two:${prompt}`),
    });
    expect(codeOf(() => run.steer("flow.review", "again"))).toBe("ambiguous");
    const second = run
      .work()
      .find((work) => work.kind === "agent" && work.sessionId === "session-2");
    run.send("flow.review", { target: second?.id ?? "", text: "again" });
    expect(steered).toEqual(["one:focus", "two:again"]);
    first();
    run.steer("flow.review", "last");
    expect(steered).toEqual(["one:focus", "two:again", "two:last"]);
  });

  it("ends twice without disturbing work that started after it", () => {
    const run = scope();
    const frame = run.frame(["flow", "build"]);
    const end = frame.work.begin({ command: "one", kind: "command" });
    end();
    frame.work.begin({ command: "two", kind: "command" });
    end();
    expect(
      run.work().map((work) => work.kind === "command" && work.command)
    ).toEqual(["two"]);
  });
});
