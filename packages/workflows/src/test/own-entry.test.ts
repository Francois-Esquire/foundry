import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import type { DefinitionGraphBuilder } from "../definitions";
import { WorkflowCheckpointSchema, workflowHandler } from "../queue-handler";
import type { StepSnapshot } from "../schema";
import { Snapshot } from "../slices/snapshot";
import { Step } from "../step";
import { Workflow } from "../workflow";
import { settledJob, withDurableQueue } from "./helpers/durable-queue";

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
    const { steps } = WorkflowCheckpointSchema.parse({
      steps: withProtoEntry({}, completedStep),
      tree: null,
    });

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

  test("a checkpoint keeps the step, and its output only when results are retained", async () => {
    class Summarize extends Step<null, typeof output> {
      readonly definitionKey = "own-entry.summarize";

      protected execute(): Promise<typeof output> {
        return Promise.resolve(output);
      }
    }
    class ProtoFlow extends Workflow<null, typeof output> {
      readonly definitionKey = "__proto__";

      protected define(graph: DefinitionGraphBuilder<null, unknown>): void {
        graph.step("__proto__", new Summarize()).output(() => output);
      }
    }
    class TransientProtoFlow extends ProtoFlow {
      override readonly persistence = { results: "transient" } as const;
    }
    const checkpointed = (workflow: ProtoFlow) =>
      withDurableQueue((queue) =>
        Effect.gen(function* () {
          yield* queue.register(
            "proto",
            workflowHandler(() => workflow.factory()(null))
          );
          const job = yield* queue.submit({ handler: { name: "proto" } });
          yield* settledJob(queue, job.id);
          const [run] = yield* queue.listRuns({ jobId: job.id });
          return WorkflowCheckpointSchema.parse(run?.checkpoint).steps;
        })
      );

    const key = "__proto__";
    const retained = ownEntry(await checkpointed(new ProtoFlow()), key);
    const transient = ownEntry(
      await checkpointed(new TransientProtoFlow()),
      key
    );

    expect(retained).toMatchObject({ output, status: "complete" });
    expect(transient).toMatchObject({ name: "__proto__", status: "complete" });
    expect(transient).not.toHaveProperty("output");
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
