/**
 * Model-turn and tool-call observations: recorded on the run that owns the
 * session, for a workflow step and a host task alike, with identity, timing,
 * status, a safe error code and only the usage a provider reported.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import { agent } from "~/authoring/resources";
import type { Engine } from "~/lib/engine";
import type {
  ExecutionObservation,
  ModelTurnObservation,
} from "~/lib/executions";
import {
  composeObservers,
  runTurnObserver,
  toolObserver,
} from "~/lib/observations";
import { testEngine } from "../helpers/engine";

let root: string;
const engines: Engine[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-observations-"));
});

afterEach(async () => {
  catalog.reset();
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
  await rm(root, { force: true, recursive: true });
});

function recorder() {
  const recorded: ExecutionObservation[] = [];
  return {
    latest: () => [
      ...new Map(recorded.map((item) => [item.id, item])).values(),
    ],
    record: (observation: ExecutionObservation) => {
      recorded.push(observation);
    },
    recorded,
  };
}

function usage(
  input: number | undefined,
  output: number | undefined
): LanguageModelV4Usage {
  return {
    inputTokens: {
      cacheRead: undefined,
      cacheWrite: undefined,
      noCache: undefined,
      total: input,
    },
    outputTokens: { reasoning: undefined, text: undefined, total: output },
  };
}

function generating(...reports: LanguageModelV4Usage[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: () => {
      const reported = reports[call] ?? usage(undefined, undefined);
      call += 1;
      return Promise.resolve({
        content: [{ text: "ok", type: "text" }],
        finishReason: { raw: undefined, unified: "stop" },
        usage: reported,
        warnings: [],
      });
    },
  });
}

it("keeps usage a provider did not report unknown, and sums what every call reported", async () => {
  const { latest, record } = recorder();
  const observe = runTurnObserver(record);
  const turn = observe({ model: { id: "m", provider: "p" }, sessionId: "s" });
  if (!turn) {
    throw new Error("expected an observation");
  }
  const model = turn.wrap(generating(usage(3, undefined), usage(4, undefined)));
  const options = { prompt: [] };
  await model.doGenerate(options);
  await model.doGenerate(options);
  turn.emit();
  expect(latest()).toEqual([
    expect.objectContaining({
      kind: "model-turn",
      status: "complete",
      usage: { inputTokens: 7, source: "provider" },
    }),
  ]);

  const partial = observe({ model: { id: "m" }, sessionId: "s" });
  const partialModel = partial?.wrap(
    generating(usage(3, 1), usage(undefined, undefined))
  );
  await partialModel?.doGenerate(options);
  await partialModel?.doGenerate(options);
  partial?.emit();
  const unknown = latest()[1] as ModelTurnObservation;
  expect(unknown.status).toBe("complete");
  expect(unknown.usage).toBeUndefined();
  expect(unknown.provider).toBeUndefined();
});

it("records a failed turn's error code, never its message, and settles once", () => {
  const { recorded, record } = recorder();
  const outer: string[] = [];
  const observe = composeObservers(
    () => ({
      emit: () => {
        outer.push("emitted");
      },
      telemetry: {},
      wrap: (model) => model,
    }),
    runTurnObserver(record)
  );
  const turn = observe({ model: { id: "m" }, sessionId: "s" });
  const error = Object.assign(new Error("key sk-live-123 rejected"), {
    name: "APICallError",
    statusCode: 401,
  });
  turn?.emit(error);
  turn?.emit();
  expect(recorded.at(-1)).toMatchObject({
    errorCode: "APICallError:401",
    status: "failed",
  });
  expect(JSON.stringify(recorded)).not.toContain("sk-live-123");
  expect(outer).toEqual(["emitted", "emitted"]);
  const aborted = observe({ model: { id: "m" }, sessionId: "s" });
  aborted?.emit(new DOMException("stopped", "AbortError"));
  expect(recorded.at(-1)).toMatchObject({
    errorCode: "AbortError",
    status: "cancelled",
  });
});

it("records a CLI harness's own tool events, and closes calls a turn left open", () => {
  const { latest, record } = recorder();
  const tools = toolObserver(record, "s");
  const event = (
    outcome: "started" | "ran" | "refused" | "failed",
    toolCallId: string
  ) =>
    tools.event({
      event: {
        agentId: "a",
        harness: "codex",
        inputSummary: "rm -rf /secret",
        outcome,
        sessionId: "s",
        toolCallId,
        toolName: "shell",
      },
      type: "harness-tool",
    });
  event("started", "1");
  event("ran", "1");
  event("refused", "2");
  event("started", "3");
  event("failed", "3");
  tools.event({
    input: { path: "/secret" },
    name: "read",
    toolCallId: "4",
    type: "tool-call",
  });
  tools.event({
    isError: true,
    output: "boom",
    toolCallId: "4",
    type: "tool-result",
  });
  tools.event({
    input: {},
    name: "bash",
    toolCallId: "5",
    type: "tool-call",
  });
  tools.end();
  expect(
    latest().map((item) => [
      item.id,
      item.status,
      item.errorCode,
      "name" in item ? item.name : undefined,
    ])
  ).toEqual([
    ["s:1", "complete", undefined, "shell"],
    ["s:2", "denied", "refused", "shell"],
    ["s:3", "failed", "failed", "shell"],
    ["s:4", "failed", "tool_error", "read"],
    ["s:5", "cancelled", undefined, "bash"],
  ]);
  expect(JSON.stringify(latest())).not.toContain("secret");
});

it("records a workflow step's agent turns on its run", async () => {
  const reviewer = agent({ prompt: "Review in private." });
  step("review").do(async ({ agents }) => {
    const session = await agents.session(reviewer);
    return (await session.generate("look at the private tests")).text;
  });
  const engine = testEngine({ root, state: join(root, "state") });
  engines.push(engine);
  await engine.start();
  const launched = await engine.launch<string>("review", {});
  await launched.result;
  const run = engine.executions.get(launched.id);
  expect(run?.observations).toEqual([
    expect.objectContaining({
      kind: "model-turn",
      status: "complete",
      usage: expect.objectContaining({
        inputTokens: expect.any(Number),
        source: "provider",
      }),
    }),
  ]);
  const file = await readFile(
    join(root, "state", "executions", `${launched.id}.json`),
    "utf8"
  );
  expect(file).toContain("model-turn");
  expect(file).not.toContain("private");
});

it("records an agent definition's one-turn call on its workflow run", async () => {
  const reviewer = agent({ prompt: "Review in private." });
  step("one-turn-review").do(
    async () => (await reviewer.generate("look at the private tests")).text
  );
  const engine = testEngine({ root });
  engines.push(engine);
  await engine.start();
  const launched = await engine.launch<string>("one-turn-review", {});
  expect(await launched.result).toContain("private tests");
  expect(engine.executions.get(launched.id)?.observations).toEqual([
    expect.objectContaining({ kind: "model-turn", status: "complete" }),
  ]);
});

it("records a host task's agent turns on its run, correlated to the agent session", async () => {
  const engine = testEngine({ root });
  engines.push(engine);
  engine.task<string, string>({
    name: "authoring-turn",
    queue: "module:notes:authoring",
    run: async (prompt, { agents }) => {
      const session = await agents.session({
        id: "works-coder",
        kind: "agent",
        prompt: "Edit the module.",
      });
      return (await session.generate(prompt)).text;
    },
  });
  await engine.start();
  const launched = await engine.launch<string>("authoring-turn", "rename", {
    correlation: { agentSessionId: "chat-1", moduleId: "notes" },
  });
  expect(await launched.result).toContain("rename");
  const run = engine.executions.get(launched.id);
  expect(run).toMatchObject({
    correlation: { agentSessionId: "chat-1", moduleId: "notes" },
    queue: "module:notes:authoring",
    status: "complete",
  });
  expect(run?.observations).toEqual([
    expect.objectContaining({ kind: "model-turn", status: "complete" }),
  ]);
});
