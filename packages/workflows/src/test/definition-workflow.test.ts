import { describe, expect, it } from "vitest";

import type { DefinitionGraphBuilder, DefinitionSource } from "../definitions";

import { Step } from "../step";
import { Workflow } from "../workflow";
import { materializeWorkflow } from "./helpers/definitions";

class AddOne extends Step<number, number> {
  readonly definitionKey = "math.add-one";
  calls = 0;

  protected async execute(input: number): Promise<number> {
    this.calls += 1;
    return input + 1;
  }
}

class FormatNumber extends Step<number, string> {
  readonly definitionKey = "math.format";
  readonly name = "Format number";

  protected async execute(input: number): Promise<string> {
    return `value:${String(input)}`;
  }
}

class MathWorkflow extends Workflow<number, string> {
  readonly definitionKey = "math.pipeline";
  readonly name = "Math pipeline";
  readonly description = "Increment then format one number.";
  readonly #add = new AddOne();
  readonly #format = new FormatNumber();
  defineCalls = 0;

  get addCalls(): number {
    return this.#add.calls;
  }

  protected define(graph: DefinitionGraphBuilder<number, string>): void {
    this.defineCalls += 1;
    graph
      .step("add", this.#add, ({ input }) => input)
      .step("format", this.#format, ({ add }) => add)
      .output(({ format }) => format);
  }
}

class MissingOutputWorkflow extends Workflow<void, string> {
  readonly definitionKey = "missing-output";
  readonly #step = new FormatNumber();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step("format", this.#step, () => 1);
  }
}

class DuplicateOutputWorkflow extends Workflow<void, string> {
  readonly definitionKey = "duplicate-output";

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.output(() => "first");
    graph.output(() => "second");
  }
}

class ThrowingStep extends Step<void, never> {
  readonly definitionKey = "throws";

  protected async execute(): Promise<never> {
    throw new TypeError("original child diagnostic");
  }
}

class ThrowingWorkflow extends Workflow<void, string> {
  readonly definitionKey = "throws.workflow";
  readonly #step = new ThrowingStep();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step("throw", this.#step, () => undefined).output(() => "never");
  }
}

describe("definition-backed Workflow", () => {
  it("projects its graph before input without executing child behavior", () => {
    const workflow = new MathWorkflow();

    expect(workflow.definition).toEqual({
      definitionKey: "math.pipeline",
      description: "Increment then format one number.",
      graph: {
        children: [
          {
            definitionKey: "math.add-one",
            kind: "step",
            nodeKey: "add",
          },
          {
            definitionKey: "math.format",
            kind: "step",
            name: "Format number",
            nodeKey: "format",
          },
        ],
        definitionKey: "math.pipeline",
        description: "Increment then format one number.",
        kind: "workflow",
        name: "Math pipeline",
        nodeKey: "math.pipeline",
      },
      kind: "workflow",
      name: "Math pipeline",
      schemaVersion: 1,
    });
    expect(JSON.stringify(workflow.definition)).not.toContain("output");
    expect(workflow.addCalls).toBe(0);
    expect(workflow.defineCalls).toBe(1);
  });

  it("uses one memoized plan for detached projection and fresh runtime execution", async () => {
    const workflow = new MathWorkflow();
    const before = workflow.definition;
    const first = materializeWorkflow(workflow, 1);
    const second = materializeWorkflow(workflow, 4);

    expect(first).not.toBe(second);
    expect(first.root).not.toBe(second.root);
    expect(first.root.id).not.toBe(second.root.id);
    expect(before).toEqual(workflow.definition);
    await expect(first.run()).resolves.toBe("value:2");
    await expect(second.run()).resolves.toBe("value:5");
    expect(first.root.steps["math.pipeline.add"]?.output).toBe(2);
    expect(first.root.steps["math.pipeline.format"]?.output).toBe("value:2");
    expect(workflow.addCalls).toBe(2);
    expect(workflow.defineCalls).toBe(1);
  });

  it("runs reusable workflows concurrently through the Promise boundary", async () => {
    const workflow = new MathWorkflow();
    const acceptsStepDefinition = <I, O>(
      definition: DefinitionSource<I, O>
    ): DefinitionSource<I, O> => definition;

    expect(acceptsStepDefinition(workflow)).toBe(workflow);

    await expect(
      Promise.all([workflow.run(2), workflow.run(8)])
    ).resolves.toEqual(["value:3", "value:9"]);
  });

  it("rejects missing and duplicate outputs before runtime allocation", () => {
    expect(() => new MissingOutputWorkflow().definition).toThrow(
      /exactly one output/
    );
    expect(() => new DuplicateOutputWorkflow().definition).toThrow(
      /exactly one output/
    );
  });

  it("retains original child execution errors", async () => {
    await expect(new ThrowingWorkflow().run(undefined)).rejects.toThrow(
      new TypeError("original child diagnostic")
    );
  });
});
