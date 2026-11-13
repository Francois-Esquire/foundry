/**
 * Model-turn and tool-call observations: recorded on the run that owns the
 * session, for a workflow step and a host task alike, with identity, timing,
 * status, a safe error code and only the usage a provider reported.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { HarnessSession } from "@foundry/agents/harness";
import type {
  SessionMessage,
  SessionStream,
  SessionUsage,
} from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { observedSession } from "~/lib/sandbox/wrapped-session";
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

/** A model whose n-th stream is `streams[n]`: parts to send, or how it fails. */
function streaming(
  ...streams: (
    | { readonly parts: LanguageModelV4StreamPart[]; readonly error?: Error }
    | { readonly refused: Error }
  )[]
) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: () => {
      const next = streams[call];
      call += 1;
      if (!next || "refused" in next) {
        return Promise.reject(next?.refused ?? new Error("no stream"));
      }
      return Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            for (const part of next.parts) {
              controller.enqueue(part);
            }
            if (next.error) {
              controller.error(next.error);
            } else {
              controller.close();
            }
          },
        }),
      });
    },
  });
}

function finish(reported: LanguageModelV4Usage): LanguageModelV4StreamPart {
  return {
    finishReason: { raw: undefined, unified: "stop" },
    type: "finish",
    usage: reported,
  };
}

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) {
      return;
    }
  }
}

it("keeps a turn's usage unknown when a later stream ends without reporting, and never counts a request the provider refused", async () => {
  const { latest, record } = recorder();
  const observe = runTurnObserver(record);
  const options = { prompt: [] };

  const cut = observe({ model: { id: "m" }, sessionId: "s" });
  const cutModel = cut?.wrap(
    streaming(
      { parts: [finish(usage(3, 1))] },
      { error: new Error("socket closed"), parts: [] }
    )
  );
  await drain(
    (await cutModel?.doStream(options))?.stream ?? new ReadableStream()
  );
  const second = await cutModel?.doStream(options);
  await expect(drain(second?.stream ?? new ReadableStream())).rejects.toThrow();
  cut?.emit(new Error("socket closed"));
  expect((latest()[0] as ModelTurnObservation).usage).toBeUndefined();

  const retried = observe({ model: { id: "m" }, sessionId: "s" });
  const retriedModel = retried?.wrap(
    streaming(
      { refused: Object.assign(new Error("busy"), { statusCode: 429 }) },
      { parts: [finish(usage(3, 1))] }
    )
  );
  await expect(retriedModel?.doStream(options)).rejects.toThrow("busy");
  await drain(
    (await retriedModel?.doStream(options))?.stream ?? new ReadableStream()
  );
  retried?.emit();
  expect((latest()[1] as ModelTurnObservation).usage).toEqual({
    inputTokens: 3,
    outputTokens: 1,
    source: "provider",
    totalTokens: 4,
  });
});

it("does not infer denial from business result data, even an exact refusal shape", () => {
  const { latest, record } = recorder();
  const tools = toolObserver(record, "s");
  const outputs = [
    { approved: false, reason: "Denied by harness profile." },
    { approved: false, reason: "out of stock", sku: "a-1" },
    { approved: false, reason: 3 },
    { approved: false },
  ];
  for (const [index, output] of outputs.entries()) {
    const toolCallId = String(index);
    tools.event({ input: {}, name: "check", toolCallId, type: "tool-call" });
    tools.event({ output, toolCallId, type: "tool-result" });
  }
  expect(latest().map((item) => item.status)).toEqual([
    "complete",
    "complete",
    "complete",
    "complete",
  ]);
});

function message(status: SessionMessage["status"]): SessionMessage {
  return {
    createdAt: 1,
    id: "m",
    parts: [],
    role: "assistant",
    sessionId: "cli",
    status,
    updatedAt: 1,
  };
}

/** A CLI harness session whose turn is `turn`, given the turn's options. */
function cliHarness(
  turn: (options: Parameters<HarnessSession["stream"]>[1]) => {
    readonly message: Promise<SessionMessage>;
    readonly usage?: Promise<SessionUsage>;
  }
): HarnessSession {
  return {
    capabilities: { interruption: true, steering: false },
    generate: () => Promise.reject(new Error("generate goes through stream")),
    interrupt: () => Promise.resolve(),
    route: { harness: "codex", id: "gpt-5", provider: "codex" },
    sessionId: "cli",
    steer: () => Promise.resolve(),
    store: new InMemorySessionStore(),
    stream: ((_input, options) => {
      const { message: settled, usage: reported } = turn(options);
      const usageOf = reported ?? Promise.reject(new Error("no usage"));
      usageOf.catch(() => undefined);
      settled.catch(() => undefined);
      return { message: settled, usage: usageOf } as unknown as SessionStream;
    }) as HarnessSession["stream"],
  };
}

it("records a CLI harness's turns: timing, outcome and the usage it reported", async () => {
  const { latest, record } = recorder();
  const reported: SessionUsage = {
    cachedInputTokens: 2,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  };
  const session = observedSession(
    cliHarness(() => ({
      message: Promise.resolve(message("complete")),
      usage: Promise.resolve(reported),
    })),
    record,
    { tools: false, turns: true }
  );
  await session.generate("go");
  await vi.waitFor(() => expect(latest()[0]?.status).toBe("complete"));
  expect(latest()[0]).toMatchObject({
    endedAt: expect.any(String),
    kind: "model-turn",
    model: "gpt-5",
    provider: "codex",
    sessionId: "cli",
    usage: {
      cachedInputTokens: 2,
      inputTokens: 10,
      outputTokens: 5,
      source: "provider",
      totalTokens: 15,
    },
  });

  const failing = observedSession(
    cliHarness(() => ({ message: Promise.resolve(message("error")) })),
    record,
    { tools: false, turns: true }
  );
  await failing.generate("go");
  await vi.waitFor(() =>
    expect(latest()[1]).toMatchObject({
      errorCode: "turn_error",
      status: "failed",
    })
  );
  expect((latest()[1] as ModelTurnObservation).usage).toBeUndefined();

  const controller = new AbortController();
  const stopped = observedSession(
    cliHarness((options) => ({
      message: new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("stopped"))
        )
      ),
    })),
    record,
    { tools: false, turns: true }
  );
  const turn = stopped.stream("go", { signal: controller.signal });
  expect(latest()[2]?.status).toBe("running");
  controller.abort();
  await expect(turn.message).rejects.toThrow("stopped");
  await vi.waitFor(() => expect(latest()[2]?.status).toBe("cancelled"));
});

it("records a delegated child's tool calls under its own session, and still hands them to the caller", async () => {
  const { latest, record } = recorder();
  const seen: string[] = [];
  const child = observedSession(
    cliHarness((options) => {
      options?.onToolCall?.({ input: {}, name: "read", toolCallId: "1" });
      options?.onToolResult?.({ output: "ok", toolCallId: "1" });
      options?.onToolCall?.({ input: {}, name: "bash", toolCallId: "2" });
      return { message: Promise.resolve(message("complete")) };
    }),
    record,
    { tools: true, turns: false }
  );
  await child.stream("go", {
    onToolCall: (event) => seen.push(event.name),
  }).message;
  await vi.waitFor(() => expect(latest()).toHaveLength(2));
  expect(latest().map((item) => [item.id, item.status])).toEqual([
    ["cli:1", "complete"],
    // Left open by the turn: it ends with it.
    ["cli:2", "cancelled"],
  ]);
  expect(seen).toEqual(["read", "bash"]);
});

it("stops a turn a host task left streaming before the task's run settles", async () => {
  const engine = testEngine({ hold: () => true, root });
  engines.push(engine);
  let left: SessionStream | undefined;
  engine.task<string, string>({
    name: "fire-and-forget",
    run: async (prompt, { agents }) => {
      const session = await agents.session({
        id: "streamer",
        kind: "agent",
        prompt: "Stream.",
      });
      // Returned without awaiting the turn.
      left = session.stream(prompt);
      return "returned";
    },
  });
  await engine.start();
  const launched = await engine.launch<string>("fire-and-forget", "go on");

  await expect(launched.result).resolves.toBe("returned");
  const run = engine.executions.get(launched.id);
  expect(run?.status).toBe("complete");
  const [turn] = run?.observations ?? [];
  expect(turn).toMatchObject({ kind: "model-turn" });
  // It ended, and was recorded ending, before the run settled.
  expect(turn?.status).toBe("cancelled");
  expect(turn?.endedAt).toEqual(expect.any(String));
  await expect(
    Promise.race([
      left?.message.then(
        () => "settled",
        () => "settled"
      ),
      new Promise((resolve) => setTimeout(() => resolve("running"), 50)),
    ])
  ).resolves.toBe("settled");
});

it.each(["generate", "stream"] as const)(
  "keeps usage unknown after an accepted %s request rejects without a response",
  async (mode) => {
    const { latest, record } = recorder();
    const observation = runTurnObserver(record)({
      model: { id: "m" },
      sessionId: "s",
    });
    let calls = 0;
    const model = observation?.wrap(
      mode === "stream"
        ? streaming(
            { parts: [finish(usage(3, 1))] },
            { refused: new Error("response lost") }
          )
        : new MockLanguageModelV4({
            doGenerate: () => {
              calls += 1;
              if (calls > 1) {
                return Promise.reject(new Error("response lost"));
              }
              return Promise.resolve({
                content: [],
                finishReason: { raw: undefined, unified: "stop" },
                usage: usage(3, 1),
                warnings: [],
              });
            },
          })
    );
    if (mode === "stream") {
      const response = await model?.doStream({ prompt: [] });
      if (!response) {
        throw new Error("missing response");
      }
      await drain(response.stream);
      await expect(model?.doStream({ prompt: [] })).rejects.toThrow(
        "response lost"
      );
    } else {
      await model?.doGenerate({ prompt: [] });
      await expect(model?.doGenerate({ prompt: [] })).rejects.toThrow(
        "response lost"
      );
    }
    observation?.emit(new Error("response lost"));
    expect((latest()[0] as ModelTurnObservation).usage).toBeUndefined();
  }
);
