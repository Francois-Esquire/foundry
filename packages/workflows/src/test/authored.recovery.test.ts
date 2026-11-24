import type { ErrorShape, JobId } from "@foundry/queue";
import type { QueueClient } from "@foundry/queue/client";
import { afterEach, describe, expect, test } from "vitest";
import type { LinearPlan, StepContract, TrustedStep } from "../authored";
import { InvocationInterrupted } from "../authored";
import {
  AUTHORED,
  clients,
  disposeClients,
  eventsOf,
  logRecords,
  makeStep,
  startAuthored,
  textInput,
  textResult,
} from "./helpers/authored-plans";
import {
  checkpointOf,
  EvidenceJournal,
  settledJob,
  sharedQueueStore,
  waitFor,
} from "./helpers/authored-queue";

afterEach(disposeClients);

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

async function placementComplete(
  client: QueueClient,
  runId: JobId,
  placement: string
): Promise<boolean> {
  const steps = (await checkpointOf(client, runId))?.steps ?? {};
  return Object.entries(steps).some(
    ([key, snap]) =>
      (key === placement || key.endsWith(`.${placement}`)) &&
      snap.status === "complete"
  );
}

async function crashAndRecover(args: {
  plan: LinearPlan;
  resolve1: (key: string) => TrustedStep;
  resolve2: (key: string) => TrustedStep;
  inputs?: Record<string, string>;
  ready: (
    client: QueueClient,
    runId: JobId,
    persistence: EvidenceJournal
  ) => Promise<boolean> | boolean;
}): Promise<{
  persistence: EvidenceJournal;
  runId: JobId;
  status: string;
  error?: ErrorShape;
}> {
  const persistence = new EvidenceJournal();
  const store = await sharedQueueStore();
  const first = await startAuthored(
    args.plan,
    args.resolve1,
    persistence,
    store
  );
  const { id } = await first.submit({
    handler: { name: AUTHORED },
    input: { inputs: args.inputs ?? {}, snapshotId: "snap" },
    policy: { retry: { maxAttempts: 2 } },
  });
  await waitFor(() => args.ready(first, id, persistence), `run ${id} ready`);
  clients.splice(clients.indexOf(first), 1);
  await first.dispose();

  const second = await startAuthored(
    args.plan,
    args.resolve2,
    persistence,
    store
  );
  await second.recover({ isOwnerGone: () => true });
  const { error, status } = await settledJob(second, id);
  return { persistence, runId: id, status, ...(error ? { error } : {}) };
}

function restartAfterProducer(args: {
  plan: LinearPlan;
  producer: string;
  resolve1: (key: string) => TrustedStep;
  resolve2: (key: string) => TrustedStep;
  inputs?: Record<string, string>;
}) {
  return crashAndRecover({
    ...args,
    ready: (client, runId) => placementComplete(client, runId, args.producer),
  });
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
      logRecords(persistence, runId),
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
      logRecords(persistence, runId),
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

    const bounds = eventsOf(logRecords(persistence, runId), "invocation-bound");
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

    const { error, persistence, runId, status } = await crashAndRecover({
      plan,
      ready: (_client, id, journal) => journal.claimed(id, "agent:effect"),
      resolve1: () => claimingStep(),
      resolve2: () => claimingStep(),
    });

    expect(status).toBe("failed");
    expect(error?.name).toBe("InvocationInterrupted");
    const interrupts = eventsOf(
      logRecords(persistence, runId),
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
