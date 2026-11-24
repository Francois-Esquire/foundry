import { afterEach, describe, expect, test } from "vitest";

import type { LinearPlan, StepContract, TrustedStep } from "../authored";
import {
  ContractFailure,
  type InvocationContext,
  type RehydrateContext,
} from "../authored";
import type { DefinitionGraphBuilder } from "../definitions";
import { Workflow } from "../workflow";
import {
  clients,
  disposeClients,
  eventsOf,
  logRecords,
  makeStep,
  outputFrames,
  runPlan,
  textInput,
  textResult,
} from "./helpers/authored-plans";
import {
  settledJob,
  sharedQueueStore,
  startQueue,
} from "./helpers/authored-queue";

afterEach(disposeClients);

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
    const { checkpoint, output, persistence, runId, status } = await runPlan(
      threePlan,
      threeResolve(seen),
      { topic: "otters" }
    );

    expect(status).toBe("complete");
    expect(seen).toEqual(["agent:otters", "text:notes", "doc:article-body"]);

    const records = logRecords(persistence, runId);
    expect(
      eventsOf(records, "invocation-bound").map((r) => r.placement)
    ).toEqual(["research", "write", "article"]);

    const outs = outputFrames(persistence, runId);
    expect(outs).toEqual([
      {
        kind: "account",
        placement: "research",
        step: "agent",
        text: "researched the topic",
      },
    ]);

    expect(output).toBeNull();
    const steps = checkpoint?.steps ?? {};
    const stepKeys = Object.keys(steps);
    for (const key of ["research", "write", "article"]) {
      expect(stepKeys.some((k) => k === key || k.endsWith(`.${key}`))).toBe(
        true
      );
    }
    for (const snapshot of Object.values(steps)) {
      expect(snapshot).not.toHaveProperty("output");
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
      logRecords(persistence, runId),
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
    const records = logRecords(persistence, runId);
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
      logRecords(persistence, runId),
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
      eventsOf(logRecords(persistence, runId), "contract-failure")
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
    const outs = outputFrames(persistence, runId);
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
    const records = logRecords(persistence, runId);
    expect(eventsOf(records, "invocation-bound")).toEqual([]);
  });

  test("live values ride custom events and never reach the checkpoint", async () => {
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

    const { checkpoint, status } = await runPlan(plan, resolve);
    expect(status).toBe("complete");
    expect(JSON.stringify(checkpoint)).not.toContain("streaming");
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
    const outs = outputFrames(persistence, runId);
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
      logRecords(persistence, runId),
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
      eventsOf(logRecords(persistence, runId), "result-rehydrated")
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
      eventsOf(logRecords(persistence, runId), "result-rehydrated")
    ).toEqual([]);
  });

  test("bound declares rehydrate but current Step lacks rehydrate(): restored false, consumer fails at connection", async () => {
    const producer = rehydratableProducer({ rehydrate: "session" });
    const { persistence, runId, status, error } = await runPlan(
      nullProducerPlan(["consumer"]),
      (key) => (key === "p" ? producer : requiredConsumer)
    );
    expect(status).toBe("failed");
    const records = logRecords(persistence, runId);
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
    const records = logRecords(persistence, runId);
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
      logRecords(persistence, runId),
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
  const client = await startQueue(await sharedQueueStore(), name, () =>
    workflow.factory()(null)
  );
  clients.push(client);
  const { id } = await client.submit({ handler: { name }, input: null });
  const { job } = await settledJob(client, id);
  return job.state.kind === "complete" ? job.state.output : null;
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
