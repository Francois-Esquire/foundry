import { afterEach, describe, expect, test } from "vitest";

import type {
  AuthoredContext,
  AuthoredRunInput,
  BoundContractRecord,
  EvidenceHost,
  InvocationContext,
  LinearPlan,
  RehydrateContext,
  StampedOutput,
  StepContract,
  TrustedStep,
} from "../authored";
import {
  ContractFailure,
  InvocationInterrupted,
  materializeLinear,
} from "../authored";
import type { DefinitionGraphBuilder } from "../definitions";
import type { JsonValue, OrchestratorStore } from "../index";
import { ExecutionCoordinator } from "../index";
import { Orchestrator } from "../orchestrator";
import type { RunJournal } from "../run-journal";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";

function journalHost(journal: RunJournal): EvidenceHost {
  const isRecord = (v: unknown): v is Record<string, JsonValue> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  return {
    async evidenceOf(runId, placement) {
      const frames = await journal.listRunFrames(runId);
      let bound: BoundContractRecord | null = null;
      const outputs: StampedOutput[] = [];
      for (const frame of frames) {
        const p = frame.payload;
        if (
          p.kind === "log" &&
          isRecord(p.value) &&
          p.value.event === "invocation-bound" &&
          p.value.placement === placement
        ) {
          bound = p.value as unknown as BoundContractRecord;
        }
        if (
          p.kind === "output" &&
          isRecord(p.value) &&
          p.value.placement === placement
        ) {
          outputs.push(p.value as unknown as StampedOutput);
        }
      }
      return { bound, outputs };
    },
    async recordEvidence(runId, record) {
      await journal.appendRunFrame({
        payload: { kind: "log", value: record as unknown as JsonValue },
        runId,
      });
    },
  };
}

interface StepOptions {
  readonly contract: StepContract;
  readonly invoke?: (
    inputs: Readonly<Record<string, string | null>>,
    ctx: InvocationContext
  ) => Promise<string | null>;
  readonly rehydrate?: (ctx: RehydrateContext) => Promise<string | null>;
}

function makeStep(key: string, options: StepOptions): TrustedStep {
  return {
    contract: options.contract,
    invoke: options.invoke ?? (async () => `result:${key}`),
    key,
    name: key,
    ...(options.rehydrate ? { rehydrate: options.rehydrate } : {}),
  };
}

const textInput = (required = true) =>
  ({
    key: "text",
    label: "Text",
    required,
    type: "text",
  }) as const;

const textResult = { type: "text" } as const;

const orchestrators: Orchestrator[] = [];

afterEach(async () => {
  while (orchestrators.length > 0) {
    const orch = orchestrators.pop();
    try {
      await orch?.stop();
    } catch {
      /* best-effort teardown */
    }
  }
});

async function startOrchestrator(
  plan: LinearPlan,
  resolve: (key: string) => TrustedStep,
  persistence: OrchestratorStore,
  queueName?: string
): Promise<{ orch: Orchestrator; host: EvidenceHost }> {
  const orch = new Orchestrator({
    config: makeOrchestratorConfig(
      queueName === undefined ? {} : { defaultName: queueName }
    ),
    store: persistence,
  });
  orchestrators.push(orch);
  await orch.setup();
  const host = journalHost(persistence);
  orch.register<AuthoredRunInput, null, AuthoredContext>(
    "workflow.authored",
    (input, execution) =>
      materializeLinear(plan, resolve, host).factory()(input, execution)
  );
  await orch.start();
  return { host, orch };
}

interface Attribution {
  readonly message: string;
  readonly name: string;
}

interface RunOutcome {
  readonly error?: Attribution;
  readonly orch: Orchestrator;
  readonly persistence: OrchestratorStore;
  readonly runId: string;
  readonly status: string;
}

async function runPlan(
  plan: LinearPlan,
  resolve: (key: string) => TrustedStep,
  inputs: Record<string, string> = {}
): Promise<RunOutcome> {
  const persistence = new ExecutionCoordinator();
  const { orch } = await startOrchestrator(plan, resolve, persistence);
  const dispatched = await orch.run<AuthoredRunInput, null>(
    "workflow.authored",
    { inputs, snapshotId: "snap" }
  );
  await dispatched.result();
  return {
    orch,
    persistence,
    runId: dispatched.id,
    status: dispatched.status,
    ...(dispatched.error ? { error: dispatched.error } : {}),
  };
}

async function logRecords(
  persistence: OrchestratorStore,
  runId: string
): Promise<Record<string, JsonValue>[]> {
  const frames = await persistence.listRunFrames(runId);
  const records: Record<string, JsonValue>[] = [];
  for (const frame of frames) {
    if (
      frame.payload.kind === "log" &&
      typeof frame.payload.value === "object" &&
      frame.payload.value !== null &&
      !Array.isArray(frame.payload.value) &&
      "event" in frame.payload.value
    ) {
      records.push(frame.payload.value);
    }
  }
  return records;
}

async function outputFrames(
  persistence: OrchestratorStore,
  runId: string
): Promise<Record<string, JsonValue>[]> {
  const frames = await persistence.listRunFrames(runId);
  return frames
    .filter((f) => f.payload.kind === "output")
    .map((f) => f.payload.value as Record<string, JsonValue>);
}

const eventsOf = (records: Record<string, JsonValue>[], event: string) =>
  records.filter((r) => r.event === event);

function readMetadata(metadata: unknown): unknown {
  return typeof metadata === "string" ? JSON.parse(metadata) : metadata;
}

const threePlan: LinearPlan = {
  inputs: [{ key: "topic", label: "Topic", required: true, type: "text" }],
  placements: [
    {
      inputs: { topic: { input: "topic", source: "run" } },
      key: "research",
      step: "agent",
    },
    {
      inputs: { text: { placement: "research", source: "connection" } },
      key: "write",
      step: "text",
    },
    {
      inputs: { text: { placement: "write", source: "connection" } },
      key: "article",
      step: "doc",
    },
  ],
  schema: 1,
};

function threeResolve(seen: string[]): (key: string) => TrustedStep {
  return (key) => {
    if (key === "agent") {
      return makeStep("agent", {
        contract: {
          inputs: [
            { key: "topic", label: "Topic", required: true, type: "text" },
          ],
          outputs: ["account"],
          result: textResult,
        },
        invoke: async (inputs, ctx) => {
          seen.push(`agent:${String(inputs.topic)}`);
          await ctx.emit({ kind: "account", text: "researched the topic" });
          return "notes";
        },
      });
    }
    if (key === "text") {
      return makeStep("text", {
        contract: { inputs: [textInput()], outputs: [], result: textResult },
        invoke: async (inputs) => {
          seen.push(`text:${String(inputs.text)}`);
          return "article-body";
        },
      });
    }
    return makeStep("doc", {
      contract: { inputs: [textInput()], outputs: [], result: textResult },
      invoke: async (inputs) => {
        seen.push(`doc:${String(inputs.text)}`);
        return "artifact-id";
      },
    });
  };
}

describe("Group A — Invocation and evidence", () => {
  test("three-placement plan: bound records in order, Results flow, no Result persisted", async () => {
    const seen: string[] = [];
    const { persistence, runId, status } = await runPlan(
      threePlan,
      threeResolve(seen),
      { topic: "otters" }
    );

    expect(status).toBe("complete");
    expect(seen).toEqual(["agent:otters", "text:notes", "doc:article-body"]);

    const records = await logRecords(persistence, runId);
    expect(
      eventsOf(records, "invocation-bound").map((r) => r.placement)
    ).toEqual(["research", "write", "article"]);

    const outs = await outputFrames(persistence, runId);
    expect(outs).toEqual([
      {
        kind: "account",
        placement: "research",
        step: "agent",
        text: "researched the topic",
      },
    ]);

    const row = await persistence.getRun(runId);
    expect(row?.output).toBeNull();
    const meta = readMetadata(row?.metadata) as {
      workflow: { steps: Record<string, Record<string, unknown>> };
      stream: { _tag: string; value?: unknown }[];
    };
    const stepKeys = Object.keys(meta.workflow.steps);
    for (const key of ["research", "write", "article"]) {
      expect(stepKeys.some((k) => k === key || k.endsWith(`.${key}`))).toBe(
        true
      );
    }
    for (const snapshot of Object.values(meta.workflow.steps)) {
      expect(snapshot).not.toHaveProperty("output");
    }
    for (const e of meta.stream.filter((s) => s._tag === "step.complete")) {
      expect(e.value).toBeNull();
    }
  });

  test("required Setting missing under a widened Contract: ContractFailure input, no invoke", async () => {
    let invoked = false;
    const plan: LinearPlan = {
      inputs: [],
      placements: [{ inputs: {}, key: "p", step: "s" }],
      schema: 1,
    };
    const resolve = () =>
      makeStep("s", {
        contract: {
          inputs: [
            { key: "prompt", label: "Prompt", required: true, type: "text" },
          ],
          outputs: [],
          result: textResult,
        },
        invoke: async () => {
          invoked = true;
          return "x";
        },
      });

    const { persistence, runId, status, error } = await runPlan(plan, resolve);

    expect(status).toBe("failed");
    expect(invoked).toBe(false);
    expect(error?.name).toBe("ContractFailure");
    expect(error?.message).toBe("s at p: input prompt is null");
    const failures = eventsOf(
      await logRecords(persistence, runId),
      "contract-failure"
    );
    expect(failures).toEqual([
      {
        boundary: "input",
        event: "contract-failure",
        key: "prompt",
        placement: "p",
        reason: "is null",
        step: "s",
      },
    ]);
    const records = await logRecords(persistence, runId);
    const boundIndex = records.findIndex((r) => r.event === "invocation-bound");
    const failureIndex = records.findIndex(
      (r) => r.event === "contract-failure"
    );
    expect(boundIndex).toBeGreaterThanOrEqual(0);
    expect(boundIndex).toBeLessThan(failureIndex);
  });

  test("wrong-typed Result: ContractFailure result, Run failed", async () => {
    const plan: LinearPlan = {
      inputs: [],
      placements: [{ inputs: {}, key: "p", step: "s" }],
      schema: 1,
    };
    const resolve = () =>
      makeStep("s", {
        contract: { inputs: [], outputs: [], result: textResult },
        invoke: async () => 42 as unknown as string,
      });

    const { persistence, runId, status, error } = await runPlan(plan, resolve);
    expect(status).toBe("failed");
    expect(error?.name).toBe("ContractFailure");
    const failures = eventsOf(
      await logRecords(persistence, runId),
      "contract-failure"
    );
    expect(failures[0]?.boundary).toBe("result");
    expect(failures[0]?.key).toBe("result");
  });

  test("a null Result with an optional consumer: consumer invoked with null, no failure", async () => {
    let consumerSaw: string | null | undefined;
    const plan: LinearPlan = {
      inputs: [],
      placements: [
        { inputs: {}, key: "producer", step: "p" },
        {
          inputs: { text: { placement: "producer", source: "connection" } },
          key: "consumer",
          step: "c",
        },
      ],
      schema: 1,
    };
    const resolve = (key: string) =>
      key === "p"
        ? makeStep("p", {
            contract: { inputs: [], outputs: ["account"], result: textResult },
            invoke: async () => null,
          })
        : makeStep("c", {
            contract: {
              inputs: [textInput(false)],
              outputs: [],
              result: textResult,
            },
            invoke: async (inputs) => {
              consumerSaw = inputs.text;
              return "done";
            },
          });

    const { runId, persistence, status } = await runPlan(plan, resolve);
    expect(status).toBe("complete");
    expect(consumerSaw).toBeNull();
    expect(
      eventsOf(await logRecords(persistence, runId), "contract-failure")
    ).toEqual([]);
  });

  test("emit then throw: the Output remains in frames, the Invocation failed", async () => {
    const plan: LinearPlan = {
      inputs: [],
      placements: [{ inputs: {}, key: "p", step: "s" }],
      schema: 1,
    };
    const resolve = () =>
      makeStep("s", {
        contract: { inputs: [], outputs: ["account"], result: textResult },
        invoke: async (_inputs, ctx) => {
          await ctx.emit({ kind: "account", text: "did the work" });
          throw new Error("owner refusal");
        },
      });

    const { persistence, runId, status } = await runPlan(plan, resolve);
    expect(status).toBe("failed");
    const outs = await outputFrames(persistence, runId);
    expect(outs).toEqual([
      { kind: "account", placement: "p", step: "s", text: "did the work" },
    ]);
  });

  test("unresolvable Step at start: StepUnavailable, no bound record, no invoke", async () => {
    const plan: LinearPlan = {
      inputs: [],
      placements: [{ inputs: {}, key: "p", step: "missing" }],
      schema: 1,
    };
    const resolve = () => {
      throw new Error("not admitted");
    };

    const { persistence, runId, status, error } = await runPlan(plan, resolve);
    expect(status).toBe("failed");
    expect(error?.name).toBe("StepUnavailable");
    const records = await logRecords(persistence, runId);
    expect(eventsOf(records, "invocation-bound")).toEqual([]);
  });

  test("live values ride custom events and never reach the persisted stream", async () => {
    const plan: LinearPlan = {
      inputs: [],
      placements: [{ inputs: {}, key: "p", step: "s" }],
      schema: 1,
    };
    const resolve = () =>
      makeStep("s", {
        contract: { inputs: [], outputs: [], result: textResult },
        invoke: async (_inputs, ctx) => {
          ctx.live({ chunk: "streaming" });
          return "final";
        },
      });

    const { persistence, runId, status } = await runPlan(plan, resolve);
    expect(status).toBe("complete");
    const row = await persistence.getRun(runId);
    const meta = readMetadata(row?.metadata) as {
      stream: { _tag: string }[];
    };
    expect(meta.stream.some((e) => e._tag === "custom")).toBe(false);
  });

  test("stamping ignores placement/step a Step supplies", async () => {
    const plan: LinearPlan = {
      inputs: [],
      placements: [{ inputs: {}, key: "real-placement", step: "s" }],
      schema: 1,
    };
    const resolve = () =>
      makeStep("s", {
        contract: { inputs: [], outputs: ["value"], result: textResult },
        invoke: async (_inputs, ctx) => {
          await ctx.emit({
            kind: "value",
            label: "n",
            placement: "forged",
            step: "forged-step",
            value: 1,
          } as unknown as Parameters<InvocationContext["emit"]>[0]);
          return "ok";
        },
      });

    const { persistence, runId } = await runPlan(plan, resolve);
    const outs = await outputFrames(persistence, runId);
    expect(outs[0]?.placement).toBe("real-placement");
    expect(outs[0]?.step).toBe("s");
  });
});

function nullProducerPlan(consumers: string[]): LinearPlan {
  return {
    inputs: [],
    placements: [
      { inputs: {}, key: "producer", step: "p" },
      ...consumers.map((key) => ({
        inputs: {
          text: { placement: "producer", source: "connection" as const },
        },
        key,
        step: "c",
      })),
    ],
    schema: 1,
  };
}

function rehydratableProducer(options: {
  rehydrate?: StepContract["rehydrate"];
  rehydrateImpl?: (ctx: RehydrateContext) => Promise<string | null>;
}): TrustedStep {
  return makeStep("p", {
    contract: {
      inputs: [],
      outputs: ["session"],
      result: textResult,
      ...(options.rehydrate ? { rehydrate: options.rehydrate } : {}),
    },
    invoke: async (_inputs, ctx) => {
      await ctx.emit({ kind: "session", sessionId: "run:producer" });
      return null;
    },
    ...(options.rehydrateImpl ? { rehydrate: options.rehydrateImpl } : {}),
  });
}

const requiredConsumer = makeStep("c", {
  contract: { inputs: [textInput()], outputs: [], result: textResult },
  invoke: async (inputs) => `used:${String(inputs.text)}`,
});

describe("Group B — absent Results and rehydration (in-process)", () => {
  test("bound rehydrate declared and implemented: RehydrationRecord restored, consumer proceeds", async () => {
    const producer = rehydratableProducer({
      rehydrate: "session",
      rehydrateImpl: async (ctx) => {
        expect(ctx.outputs[0]?.kind).toBe("session");
        return "restored-notes";
      },
    });
    let consumerSaw: string | null | undefined;
    const resolve = (key: string) =>
      key === "p"
        ? producer
        : makeStep("c", {
            contract: {
              inputs: [textInput()],
              outputs: [],
              result: textResult,
            },
            invoke: async (inputs) => {
              consumerSaw = inputs.text;
              return "ok";
            },
          });

    const { persistence, runId, status } = await runPlan(
      nullProducerPlan(["consumer"]),
      resolve
    );
    expect(status).toBe("complete");
    expect(consumerSaw).toBe("restored-notes");
    const rehydrations = eventsOf(
      await logRecords(persistence, runId),
      "result-rehydrated"
    );
    expect(rehydrations).toEqual([
      {
        event: "result-rehydrated",
        from: "session",
        placement: "producer",
        restored: true,
        step: "p",
      },
    ]);
  });

  test("two consumers of one source: exactly one RehydrationRecord", async () => {
    let calls = 0;
    const producer = rehydratableProducer({
      rehydrate: "session",
      rehydrateImpl: async () => {
        calls += 1;
        return "restored";
      },
    });
    const { persistence, runId, status } = await runPlan(
      nullProducerPlan(["c1", "c2"]),
      (key) => (key === "p" ? producer : requiredConsumer)
    );
    expect(status).toBe("complete");
    expect(calls).toBe(1);
    expect(
      eventsOf(await logRecords(persistence, runId), "result-rehydrated")
    ).toHaveLength(1);
  });

  test("an unconsumed absent Result is never rehydrated", async () => {
    let calls = 0;
    const producer = rehydratableProducer({
      rehydrate: "session",
      rehydrateImpl: async () => {
        calls += 1;
        return "restored";
      },
    });
    const plan: LinearPlan = {
      inputs: [],
      placements: [
        { inputs: {}, key: "producer", step: "p" },
        { inputs: {}, key: "other", step: "c" },
      ],
      schema: 1,
    };
    const other = makeStep("c", {
      contract: { inputs: [], outputs: [], result: textResult },
      invoke: async () => "independent",
    });
    const { persistence, runId, status } = await runPlan(plan, (key) =>
      key === "p" ? producer : other
    );
    expect(status).toBe("complete");
    expect(calls).toBe(0);
    expect(
      eventsOf(await logRecords(persistence, runId), "result-rehydrated")
    ).toEqual([]);
  });

  test("bound declares rehydrate but current Step lacks rehydrate(): restored false, consumer fails at connection", async () => {
    const producer = rehydratableProducer({ rehydrate: "session" });
    const { persistence, runId, status, error } = await runPlan(
      nullProducerPlan(["consumer"]),
      (key) => (key === "p" ? producer : requiredConsumer)
    );
    expect(status).toBe("failed");
    const records = await logRecords(persistence, runId);
    expect(eventsOf(records, "result-rehydrated")).toEqual([
      {
        event: "result-rehydrated",
        from: "session",
        placement: "producer",
        reason: "rehydrate-not-implemented",
        restored: false,
        step: "p",
      },
    ]);
    const [failure] = eventsOf(records, "contract-failure");
    expect(failure?.boundary).toBe("connection");
    expect(failure?.from).toBe("producer");
    expect(error?.message).toBe("c at consumer: connection text is null");
  });

  test("no rehydrate declared: no RehydrationRecord, consumer fails at connection with from", async () => {
    const producer = rehydratableProducer({});
    const { persistence, runId, status } = await runPlan(
      nullProducerPlan(["consumer"]),
      (key) => (key === "p" ? producer : requiredConsumer)
    );
    expect(status).toBe("failed");
    const records = await logRecords(persistence, runId);
    expect(eventsOf(records, "result-rehydrated")).toEqual([]);
    const [failure] = eventsOf(records, "contract-failure");
    expect(failure?.boundary).toBe("connection");
    expect(failure?.from).toBe("producer");
  });

  test("rehydrate returns null: restored false with nothing-retained", async () => {
    const producer = rehydratableProducer({
      rehydrate: "session",
      rehydrateImpl: async () => null,
    });
    const { persistence, runId } = await runPlan(
      nullProducerPlan(["consumer"]),
      (key) => (key === "p" ? producer : requiredConsumer)
    );
    const rehydrations = eventsOf(
      await logRecords(persistence, runId),
      "result-rehydrated"
    );
    expect(rehydrations[0]).toMatchObject({
      reason: "nothing-retained",
      restored: false,
    });
  });

  test("ContractFailure is thrown for a required Connection whose value stays null", () => {
    const failure = new ContractFailure("x at y: connection text is null");
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe("ContractFailure");
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function blockUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string
): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await predicate()) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

async function placementComplete(
  persistence: OrchestratorStore,
  runId: string,
  placement: string
): Promise<boolean> {
  const row = await persistence.getRun(runId);
  const meta = readMetadata(row?.metadata) as
    | { workflow?: { steps?: Record<string, { status?: string }> } }
    | null
    | undefined;
  const steps = meta?.workflow?.steps ?? {};
  return Object.entries(steps).some(
    ([key, snap]) =>
      (key === placement || key.endsWith(`.${placement}`)) &&
      snap.status === "complete"
  );
}

async function restartAfterProducer(args: {
  plan: LinearPlan;
  producer: string;
  resolve1: (key: string) => TrustedStep;
  resolve2: (key: string) => TrustedStep;
  inputs?: Record<string, string>;
}): Promise<{
  persistence: OrchestratorStore;
  runId: string;
  status: string;
  error?: Attribution;
}> {
  const persistence = new ExecutionCoordinator();
  const queueName = "restart-shared";
  const { orch: orch1 } = await startOrchestrator(
    args.plan,
    args.resolve1,
    persistence,
    queueName
  );
  const dispatched = await orch1.run<AuthoredRunInput, null>(
    "workflow.authored",
    { inputs: args.inputs ?? {}, snapshotId: "snap" }
  );
  const runId = dispatched.id;
  await waitFor(
    () => placementComplete(persistence, runId, args.producer),
    `producer ${args.producer} complete`
  );

  const { orch: orch2 } = await startOrchestrator(
    args.plan,
    args.resolve2,
    persistence,
    queueName
  );
  const recovered = await orch2.get(runId);
  if (!recovered) {
    throw new Error("expected recovered run");
  }
  await recovered.result();
  await dispatched.cancel("restart").catch(() => undefined);
  return {
    persistence,
    runId,
    status: recovered.status,
    ...(recovered.error ? { error: recovered.error } : {}),
  };
}

function blockingConsumerPlan(): LinearPlan {
  return {
    inputs: [],
    placements: [
      { inputs: {}, key: "producer", step: "p" },
      {
        inputs: { text: { placement: "producer", source: "connection" } },
        key: "consumer",
        step: "c",
      },
    ],
    schema: 1,
  };
}

const completingProducer = (rehydrate?: StepContract["rehydrate"]) =>
  makeStep("p", {
    contract: {
      inputs: [],
      outputs: ["session"],
      result: textResult,
      ...(rehydrate ? { rehydrate } : {}),
    },
    invoke: async (_inputs, ctx) => {
      await ctx.emit({ kind: "session", sessionId: "run:producer" });
      return "produced";
    },
  });

const blockingConsumer = makeStep("c", {
  contract: { inputs: [textInput()], outputs: [], result: textResult },
  invoke: async (_inputs, ctx) => blockUntilAborted(ctx.signal),
});

describe("Group C — recovery", () => {
  test("adoption with the producer's Result absent, no rehydrate: consumer fails at connection with from; producer not re-invoked", async () => {
    let producerCalls = 0;
    const resolve2 = (key: string): TrustedStep =>
      key === "p"
        ? makeStep("p", {
            contract: { inputs: [], outputs: ["session"], result: textResult },
            invoke: async () => {
              producerCalls += 1;
              return "produced";
            },
          })
        : makeStep("c", {
            contract: {
              inputs: [textInput()],
              outputs: [],
              result: textResult,
            },
            invoke: async (inputs) => `used:${String(inputs.text)}`,
          });

    const { persistence, runId, status, error } = await restartAfterProducer({
      plan: blockingConsumerPlan(),
      producer: "producer",
      resolve1: (key) =>
        key === "p" ? completingProducer() : blockingConsumer,
      resolve2,
    });

    expect(status).toBe("failed");
    expect(producerCalls).toBe(0);
    const failure = eventsOf(
      await logRecords(persistence, runId),
      "contract-failure"
    ).find((r) => r.placement === "consumer");
    expect(failure?.boundary).toBe("connection");
    expect(failure?.from).toBe("producer");
    expect(error?.message).toBe("c at consumer: connection text is null");
  });

  test("the bound Contract governs rehydration across a swap: current Contract omits rehydrate, bound still enables it", async () => {
    let producerCalls = 0;
    const resolve2 = (key: string): TrustedStep =>
      key === "p"
        ? {
            ...makeStep("p", {
              contract: {
                inputs: [],
                outputs: ["session"],
                result: textResult,
              },
              invoke: async () => {
                producerCalls += 1;
                return "produced";
              },
            }),
            rehydrate: async () => "rehydrated-from-session",
          }
        : makeStep("c", {
            contract: {
              inputs: [textInput()],
              outputs: [],
              result: textResult,
            },
            invoke: async (inputs) => `used:${String(inputs.text)}`,
          });

    const { persistence, runId, status } = await restartAfterProducer({
      plan: blockingConsumerPlan(),
      producer: "producer",
      resolve1: (key) =>
        key === "p" ? completingProducer("session") : blockingConsumer,
      resolve2,
    });

    expect(status).toBe("complete");
    expect(producerCalls).toBe(0);
    const rehydrations = eventsOf(
      await logRecords(persistence, runId),
      "result-rehydrated"
    ).filter((r) => r.placement === "producer");
    expect(rehydrations).toHaveLength(1);
    expect(rehydrations[0]).toMatchObject({ from: "session", restored: true });
  });

  test("Step-version swap: the completed placement keeps v1's Contract; the next Invocation binds v2", async () => {
    const plan: LinearPlan = {
      inputs: [],
      placements: [
        { inputs: {}, key: "p0", step: "s" },
        {
          inputs: { text: { placement: "p0", source: "connection" } },
          key: "p1",
          step: "s",
        },
      ],
      schema: 1,
    };
    const stepVersion = (version: string, block: boolean): TrustedStep =>
      makeStep("s", {
        contract: {
          inputs: [textInput(false)],
          outputs: [],
          result: { label: version, type: "text" },
        },
        invoke: async (_inputs, ctx) =>
          block ? blockUntilAborted(ctx.signal) : "produced",
      });
    let firstCalls = 0;
    const resolve1 = (): TrustedStep => {
      firstCalls += 1;
      return stepVersion("v1", firstCalls > 1);
    };
    const resolve2 = (): TrustedStep => stepVersion("v2", false);

    const { persistence, runId } = await restartAfterProducer({
      plan,
      producer: "p0",
      resolve1,
      resolve2,
    });

    const bounds = eventsOf(
      await logRecords(persistence, runId),
      "invocation-bound"
    );
    const p0Bound = bounds.find((b) => b.placement === "p0");
    const p1Bounds = bounds.filter((b) => b.placement === "p1");
    if (p0Bound === undefined) {
      throw new Error("expected a p0 invocation bound");
    }
    expect(
      (p0Bound.contract as { result?: { label?: string } }).result?.label
    ).toBe("v1");
    const lastP1 = p1Bounds.at(-1);
    if (lastP1 === undefined) {
      throw new Error("expected a p1 invocation bound");
    }
    expect(
      (lastP1.contract as { result?: { label?: string } }).result?.label
    ).toBe("v2");
  });

  test("a claim already taken on adoption: InterruptedRecord and InvocationInterrupted", async () => {
    const plan: LinearPlan = {
      inputs: [],
      placements: [{ inputs: {}, key: "effect", step: "s" }],
      schema: 1,
    };
    const claimingStep = (): TrustedStep =>
      makeStep("s", {
        contract: { inputs: [], outputs: ["account"], result: textResult },
        invoke: async (_inputs, ctx) => {
          const claimed = await ctx.claimEffect("agent:effect");
          if (!claimed) {
            throw new InvocationInterrupted("agent:effect");
          }
          return blockUntilAborted(ctx.signal);
        },
      });

    const persistence = new ExecutionCoordinator();
    const queueName = "restart-interrupt";
    const { orch: orch1 } = await startOrchestrator(
      plan,
      () => claimingStep(),
      persistence,
      queueName
    );
    const dispatched = await orch1.run<AuthoredRunInput, null>(
      "workflow.authored",
      { inputs: {}, snapshotId: "snap" }
    );
    const runId = dispatched.id;
    await waitFor(async () => {
      const frames = await persistence.listRunFrames(runId);
      return frames.some(
        (f) =>
          f.payload.kind === "log" &&
          typeof f.payload.value === "object" &&
          f.payload.value !== null &&
          (f.payload.value as { key?: string }).key === "agent:effect"
      );
    }, "claim frame durable");

    const { orch: orch2 } = await startOrchestrator(
      plan,
      () => claimingStep(),
      persistence,
      queueName
    );
    const recovered = await orch2.get(runId);
    if (!recovered) {
      throw new Error("expected recovered run");
    }
    await recovered.result();
    await dispatched.cancel("restart").catch(() => undefined);

    expect(recovered.status).toBe("failed");
    expect(recovered.error?.name).toBe("InvocationInterrupted");
    const interrupts = eventsOf(
      await logRecords(persistence, runId),
      "invocation-interrupted"
    );
    expect(interrupts).toEqual([
      {
        claim: "agent:effect",
        event: "invocation-interrupted",
        placement: "effect",
        step: "s",
      },
    ]);
  });
});

class OutputWorkflow extends Workflow<null, string> {
  readonly definitionKey = "test.output-workflow";
  protected define(graph: DefinitionGraphBuilder<null, string>): void {
    graph.output(() => "run-level-leak");
  }
}

class TransientOutputWorkflow extends OutputWorkflow {
  override readonly persistence = { results: "transient" } as const;
}

async function runOutputWorkflow(
  workflow: Workflow<null, string>,
  name: string
): Promise<unknown> {
  const persistence = new ExecutionCoordinator();
  const orch = new Orchestrator({
    config: makeOrchestratorConfig(),
    store: persistence,
  });
  orchestrators.push(orch);
  await orch.setup();
  orch.register(name, workflow.factory());
  await orch.start();
  const dispatched = await orch.run(name, null);
  await dispatched.result();
  const row = await persistence.getRun(dispatched.id);
  return row?.output ?? null;
}

describe("Group D — run-output strip", () => {
  test("a transient Workflow's run output is omitted; the retained twin keeps it", async () => {
    const transient = await runOutputWorkflow(
      new TransientOutputWorkflow(),
      "transient-output"
    );
    const retained = await runOutputWorkflow(
      new OutputWorkflow(),
      "retained-output"
    );
    expect(transient).toBeNull();
    expect(retained).toBe("run-level-leak");
  });
});
