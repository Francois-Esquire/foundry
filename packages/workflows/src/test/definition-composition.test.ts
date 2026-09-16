import { describe, expect, it } from "vitest";

import type { DefinitionGraphBuilder } from "../definitions";

import { Step } from "../step";
import { Workflow } from "../workflow";
import { materializeWorkflow } from "./helpers/definitions";

class AddOne extends Step<number, number> {
  readonly definitionKey = "compose.add-one";

  protected execute(input: number): Promise<number> {
    return Promise.resolve(input + 1);
  }
}

class Double extends Step<number, number> {
  readonly definitionKey = "compose.double";

  protected execute(input: number): Promise<number> {
    return Promise.resolve(input * 2);
  }
}

class CompositionWorkflow extends Workflow<number, Record<string, unknown>> {
  readonly definitionKey = "compose.workflow";
  readonly #add = new AddOne();
  readonly #double = new Double();

  protected define(
    graph: DefinitionGraphBuilder<number, Record<string, unknown>>
  ): void {
    graph
      .sequence("pipeline", [this.#add, this.#double])
      .parallel("both", { add: this.#add, double: this.#double })
      .race("winner", { add: this.#add, double: this.#double })
      .branch("choice", (input) => Number(input) > 0, {
        ifFalse: this.#double,
        ifTrue: this.#add,
      })
      .output(({ pipeline, both, winner, choice }) => ({
        both,
        choice,
        pipeline,
        winner,
      }));
  }
}

describe("definition composition compiler", () => {
  it("projects all declared group nodes before input", () => {
    const definition = new CompositionWorkflow().definition;

    expect(definition.graph.children).toMatchObject([
      { kind: "sequence", nodeKey: "pipeline" },
      { kind: "parallel", nodeKey: "both" },
      { kind: "race", nodeKey: "winner" },
      {
        children: [{ nodeKey: "ifTrue" }, { nodeKey: "ifFalse" }],
        kind: "branch",
        nodeKey: "choice",
      },
    ]);
    for (const node of definition.graph.children ?? []) {
      expect(node).not.toHaveProperty("definitionKey");
    }
  });

  it("compiles declared groups through the current runtime primitives", async () => {
    const output = await new CompositionWorkflow().run(2);

    expect(output).toMatchObject({
      both: { add: 3, double: 4 },
      choice: 3,
      pipeline: 6,
    });
    expect(output.winner).toMatchObject({ value: 3, winner: "add" });
  });

  it("marks the unselected declared branch arm skipped", async () => {
    const runtime = materializeWorkflow(new CompositionWorkflow(), -1);

    await expect(runtime.run()).resolves.toMatchObject({ choice: -2 });
    expect(runtime.root.steps["compose.workflow.choice.ifTrue"]?.status).toBe(
      "skipped"
    );
    expect(runtime.root.steps["compose.workflow.choice.ifFalse"]?.status).toBe(
      "complete"
    );
  });
});
