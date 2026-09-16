import { describe, expect, it } from "vitest";

import type { DefinitionGraphBuilder } from "../definitions";
import type { BaseContext } from "../executable";
import type { RunExecutionContext } from "../orchestrator";

import { Orchestrator } from "../orchestrator";
import { Step } from "../step";
import { InMemoryOrchestratorStore } from "../store";
import { Workflow } from "../workflow";
import { makeOrchestratorConfig } from "./helpers/config";

interface Gate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function makeGate(): Gate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class Double extends Step<number, number> {
  readonly definitionKey = "definition.double";

  protected async execute(input: number): Promise<number> {
    return input * 2;
  }
}

class DoubleWorkflow extends Workflow<number, string> {
  readonly definitionKey = "definition.double-workflow";
  readonly #double = new Double();

  protected define(graph: DefinitionGraphBuilder<number, string>): void {
    graph
      .step("double", this.#double, ({ input }) => input)
      .output(({ double }) => `result:${String(double)}`);
  }
}

interface DurableContext extends BaseContext {
  readonly execution: RunExecutionContext;
}

class DurableEffect extends Step<string, string, DurableContext> {
  readonly definitionKey = "definition.durable-effect";
  readonly #gate: Gate;
  effectRuns = 0;
  emittedOutputs = 0;

  constructor(gate: Gate) {
    super();
    this.#gate = gate;
  }

  protected async execute(
    input: string,
    context: DurableContext
  ): Promise<string> {
    const claimed = await context.execution.claimEffect("external-write", {
      input,
    });
    if (!claimed) {
      return `recovered:${input}`;
    }

    this.effectRuns += 1;
    this.emittedOutputs += 1;
    await context.execution.emitOutput({ input, state: "recorded" });
    await this.#gate.promise;
    return `initial:${input}`;
  }
}

class DurableWorkflow extends Workflow<string, string, DurableContext> {
  readonly definitionKey = "definition.durable-workflow";
  readonly #effect: DurableEffect;
  readonly runtimes: Workflow<string, string, DurableContext>[] = [];

  constructor(effect: DurableEffect) {
    super();
    this.#effect = effect;
  }

  override factory() {
    const factory = super.factory();
    return (input: string, execution?: RunExecutionContext) => {
      const runtime = factory(input, execution) as Workflow<
        string,
        string,
        DurableContext
      >;
      this.runtimes.push(runtime);
      return runtime;
    };
  }

  protected define(
    graph: DefinitionGraphBuilder<string, string, DurableContext>
  ): void {
    graph
      .step("effect", this.#effect, ({ input }) => input)
      .output(({ effect }) => effect);
  }
}

describe("definition factories with Orchestrator", () => {
  it("registers Step and Workflow definitions beside legacy static factories", async () => {
    const orchestrator = new Orchestrator({
      config: makeOrchestratorConfig(),
      store: new InMemoryOrchestratorStore(),
    });
    const step = new Double();
    const workflow = new DoubleWorkflow();

    await orchestrator.setup();
    orchestrator.register(step.definitionKey, step.factory());
    orchestrator.register(workflow.definitionKey, workflow.factory());
    orchestrator.register("legacy.step", (input: number) =>
      Step.create({
        execute: async (value) => value + 1,
        input,
        name: "legacy.step",
      })
    );
    orchestrator.register("legacy.workflow", (input: number) =>
      Workflow.create({
        execute: async (value) => `legacy:${String(value)}`,
        input,
        name: "legacy.workflow",
      })
    );
    await orchestrator.start();

    try {
      await expect(
        (await orchestrator.run(step.definitionKey, 3)).result()
      ).resolves.toMatchObject({ status: "complete", value: 6 });
      await expect(
        (await orchestrator.run(workflow.definitionKey, 3)).result()
      ).resolves.toMatchObject({ status: "complete", value: "result:6" });
      await expect(
        (await orchestrator.run("legacy.step", 3)).result()
      ).resolves.toMatchObject({ status: "complete", value: 4 });
      await expect(
        (await orchestrator.run("legacy.workflow", 3)).result()
      ).resolves.toMatchObject({ status: "complete", value: "legacy:3" });
    } finally {
      await orchestrator.stop();
    }
  });

  it("rebuilds a fresh durable runtime without repeating a claimed effect", async () => {
    const key = "definition.durable-workflow";
    const config = makeOrchestratorConfig({
      defaultName: "definition-recovery",
    });
    const source = new InMemoryOrchestratorStore();
    const gate = makeGate();
    const effect = new DurableEffect(gate);
    const definition = new DurableWorkflow(effect);
    const first = new Orchestrator({ config, store: source });

    await first.setup();
    first.register(key, definition.factory());
    await first.start();
    const dispatched = await first.run(key, "persisted-input");

    while (effect.emittedOutputs === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const restored = new InMemoryOrchestratorStore({
      snapshot: source.snapshot(),
    });
    await first.stop({ graceMs: 0 });

    const recovered = new Orchestrator({ config, store: restored });
    await recovered.setup();
    recovered.register(key, definition.factory());
    await recovered.start();

    try {
      const handle = await recovered.get(dispatched.id);
      if (!handle) {
        throw new Error("expected recovered Run");
      }
      await expect(handle.result()).resolves.toMatchObject({
        status: "complete",
        value: "recovered:persisted-input",
      });
      expect(definition.runtimes).toHaveLength(2);
      expect(definition.runtimes[0]).not.toBe(definition.runtimes[1]);
      expect(definition.runtimes[0]?.root).not.toBe(
        definition.runtimes[1]?.root
      );
      expect(definition.runtimes.map((runtime) => runtime.root.path)).toEqual([
        [key],
        [key],
      ]);
      expect(effect.effectRuns).toBe(1);
      expect(effect.emittedOutputs).toBe(1);
      expect(definition).not.toHaveProperty("runId");
      expect(definition).not.toHaveProperty("links");
      expect(definition).not.toHaveProperty("claims");
      expect(definition).not.toHaveProperty("emittedOutputs");
    } finally {
      await recovered.stop();
    }
  });
});
