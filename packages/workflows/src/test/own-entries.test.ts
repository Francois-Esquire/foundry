import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import type { DefinitionGraphBuilder } from "../definitions";
import { ExecutionCoordinator } from "../index";
import {
  decodeMetadataValue,
  encodePersistedMetadata,
  stepsFromMetadata,
} from "../metadata-codec";
import { Queue } from "../queue";
import type { StepSnapshot } from "../schema";
import { Snapshot } from "../snapshot";
import { Step } from "../step";
import type { WorkflowState } from "../workflow";
import { Workflow } from "../workflow";

/** A dictionary whose own entries include one named `__proto__`. */
function withProtoEntry<V>(
  entries: Record<string, V>,
  protoValue: V
): Record<string, V> {
  const dictionary = { ...entries };
  Object.defineProperty(dictionary, "__proto__", {
    configurable: true,
    enumerable: true,
    value: protoValue,
    writable: true,
  });
  return dictionary;
}

/** True when `value` is a plain object holding `key` as its own entry. */
function ownEntry(value: unknown, key: string): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Object.hasOwn(value, key)
  ) {
    return "<missing own entry>";
  }
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

const output = { summary: "done" };
const completedStep: StepSnapshot = {
  attempt: 1,
  name: "__proto__",
  namespace: "",
  output,
  status: "complete",
};

describe("entries named __proto__ stay own entries", () => {
  test("recovery seeding keeps a decoded step and its result", async () => {
    const decoded = decodeMetadataValue({
      workflow: { steps: withProtoEntry({}, completedStep) },
    });
    const steps = stepsFromMetadata(decoded);
    if (steps === null) {
      throw new Error("expected decoded steps");
    }

    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          yield* snapshot.seed(steps);
          return yield* snapshot.current;
        })
      )
    );

    expect(ownEntry(state.results, "__proto__")).toEqual(output);
    expect(ownEntry(state.steps, "__proto__")).toMatchObject({
      status: "complete",
    });
  });

  test("transient encoding keeps the step and removes its output", () => {
    const workflow = {
      runId: "rn-1",
      status: "complete",
      step: "flow",
      steps: withProtoEntry({}, completedStep),
    } as WorkflowState & { readonly runId: string; readonly step: string };

    const encoded = encodePersistedMetadata(workflow, [], {
      results: "transient",
    }) as { workflow: { steps: unknown } };
    const step = ownEntry(encoded.workflow.steps, "__proto__");

    expect(step).toMatchObject({ name: "__proto__", status: "complete" });
    expect(step).not.toHaveProperty("output");
  });

  test("the live snapshot seeds and updates a step keyed __proto__", async () => {
    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* Snapshot.make();
          yield* snapshot.setWorkflow({
            cursor: null,
            input: null,
            name: "flow",
            steps: [{ index: 0, key: "__proto__", name: "__proto__" }],
          });
          const pending = ownEntry(yield* snapshot.currentSteps, "__proto__");
          snapshot.applyEvent({
            _tag: "step.started",
            at: "2026-05-02T00:00:00.000Z",
            attempt: 1,
            name: "__proto__",
            path: ["__proto__"],
          });
          return { pending, state: yield* snapshot.current };
        })
      )
    );

    expect(state.pending).toMatchObject({ status: "pending" });
    expect(ownEntry(state.state.steps, "__proto__")).toMatchObject({
      attempt: 1,
      status: "running",
    });
  });

  test("a first event for a step keyed __proto__ starts from a blank step", () => {
    const progressed = (key: string) =>
      Snapshot.apply(
        {
          results: {},
          steps: {},
          updatedAt: "2026-05-02T00:00:00.000Z",
          workflow: null,
        },
        {
          _tag: "step.progress",
          at: "2026-05-02T00:00:00.000Z",
          attempt: 1,
          name: "step",
          path: [key],
          value: 0.5,
        }
      ).steps;
    const plain = ownEntry(progressed("plain"), "plain") as StepSnapshot;

    expect(plain).toMatchObject({ attempt: 0, status: "pending" });
    expect(ownEntry(progressed("__proto__"), "__proto__")).toEqual(plain);
  });

  test("stored Run data and persisted results keep the entry", async () => {
    const store = new ExecutionCoordinator();
    const created = await store.createRun({
      input: withProtoEntry<unknown>({ kept: 1 }, { nested: true }),
      metadata: { workflow: { steps: withProtoEntry({}, completedStep) } },
      queueId: "main",
      step: "flow",
    });
    const stored = await store.getRun(created.id);
    const queue = new Queue({ concurrency: 1, store });
    const results = await queue.results(created.id);
    await queue.shutdown();

    expect(ownEntry(stored?.input, "__proto__")).toEqual({ nested: true });
    expect(ownEntry(results, "__proto__")).toEqual(output);
  });

  test("definition node keys named __proto__ run and reach the output", async () => {
    class Add extends Step<number, number> {
      readonly definitionKey = "own-entry.add";

      protected execute(input: number): Promise<number> {
        return Promise.resolve(input + 1);
      }
    }
    class ProtoKeyed extends Workflow<number, unknown> {
      readonly definitionKey = "own-entry.workflow";
      readonly #add = new Add();

      protected define(graph: DefinitionGraphBuilder<number, unknown>): void {
        graph
          .step("__proto__", this.#add)
          .parallel("both", withProtoEntry({ kept: this.#add }, this.#add))
          .output((nodeValues) => nodeValues);
      }
    }

    const values = await new ProtoKeyed().run(1);

    expect(ownEntry(values, "__proto__")).toBe(2);
    expect(ownEntry(ownEntry(values, "both"), "__proto__")).toBe(2);
  });
});
