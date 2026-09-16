import { describe, expect, it } from "vitest";

import type { DefinitionGraphBuilder } from "../definitions";

import { DefinitionAuthoringError } from "../definitions";
import { Step } from "../step";
import { Workflow } from "../workflow";
import { materializeWorkflow } from "./helpers/definitions";

class Leaf extends Step<void, string> {
  readonly definitionKey = "leaf";

  protected execute(): Promise<string> {
    return Promise.resolve("ok");
  }
}

class InvalidKey extends Step<void, string> {
  readonly definitionKey = " bad ";

  protected execute(): Promise<string> {
    return Promise.resolve("bad");
  }
}

class DuplicatePlacement extends Workflow<void, string> {
  readonly definitionKey = "duplicate";
  readonly #leaf = new Leaf();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step("same", this.#leaf, () => undefined);
    graph.step("same", this.#leaf, () => undefined);
    graph.output(() => "never");
  }
}

class DuplicateSequence extends Workflow<void, string> {
  readonly definitionKey = "duplicate-sequence";
  readonly #leaf = new Leaf();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.sequence("same", [this.#leaf, this.#leaf]).output(() => "never");
  }
}

class EmptyRace extends Workflow<void, string> {
  readonly definitionKey = "empty-race";

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.race("winner", {}).output(() => "never");
  }
}

class InvalidNodeKey extends Workflow<void, string> {
  readonly definitionKey = "invalid-node";
  readonly #leaf = new Leaf();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step(" bad ", this.#leaf, () => undefined).output(() => "never");
  }
}

class RecursiveWorkflow extends Workflow<void, string> {
  readonly definitionKey = "recursive";

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step("again", this, () => undefined).output(() => "never");
  }
}

class DefaultPlacement extends Workflow<void, string> {
  readonly definitionKey = "defaults";
  readonly #leaf = new Leaf();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step(this.#leaf).output(({ leaf }) => leaf ?? "missing");
  }
}

class NestedWorkflow extends Workflow<void, string> {
  readonly definitionKey = "nested";
  readonly #leaf = new Leaf();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step(this.#leaf).output(({ leaf }) => leaf ?? "missing");
  }
}

class ParentWorkflow extends Workflow<void, string> {
  readonly definitionKey = "parent";
  readonly #nested = new NestedWorkflow();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph.step(this.#nested).output(({ nested }) => nested ?? "missing");
  }
}

class DecoratedLeaf extends Step<void, string> {
  readonly definitionKey = "stable.leaf";
  readonly name = "A mutable presentation label";
  readonly description = "Presentation only.";

  protected execute(): Promise<string> {
    return Promise.resolve("ok");
  }
}

class DotKeyWorkflow extends Workflow<void, string> {
  readonly definitionKey = "stable.workflow";
  readonly #leaf = new DecoratedLeaf();

  protected define(graph: DefinitionGraphBuilder<void, string>): void {
    graph
      .step("local.segment.with.dots", this.#leaf, () => undefined)
      .output(({ "local.segment.with.dots": value }) => value);
  }
}

describe("definition validation", () => {
  it("rejects untrimmed definition keys with stable authoring facts", () => {
    expect(() => new InvalidKey().definition).toThrow(DefinitionAuthoringError);
    try {
      void new InvalidKey().definition;
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid-definition-key",
        definitionKey: " bad ",
        path: [],
      });
    }
  });

  it("rejects duplicate sibling placement keys before runtime allocation", () => {
    expect(() => new DuplicatePlacement().definition).toThrow(
      DefinitionAuthoringError
    );
  });

  it("rejects repeated sequence behavior without an explicit alias", () => {
    expect(() => new DuplicateSequence().definition).toThrow(
      DefinitionAuthoringError
    );
    try {
      void new DuplicateSequence().definition;
    } catch (error) {
      expect(error).toMatchObject({
        code: "duplicate-node-key",
        definitionKey: "duplicate-sequence",
        path: ["leaf"],
      });
    }
  });

  it("reports an empty race as an invalid composition", () => {
    try {
      void new EmptyRace().definition;
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid-composition",
        definitionKey: "empty-race",
        path: ["winner"],
      });
      return;
    }
    throw new Error("expected invalid composition to throw");
  });

  it("rejects untrimmed local keys with the owning definition", () => {
    try {
      void new InvalidNodeKey().definition;
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid-node-key",
        definitionKey: "invalid-node",
        path: [],
      });
      return;
    }
    throw new Error("expected invalid node key to throw");
  });

  it("rejects recursive definition planning without memoizing a partial plan", () => {
    const workflow = new RecursiveWorkflow();

    expect(() => workflow.definition).toThrow(DefinitionAuthoringError);
    expect(() => workflow.definition).toThrow(/definition-cycle/);
  });

  it("uses a child definitionKey as the default local placement key", () => {
    expect(new DefaultPlacement().definition.graph.children).toMatchObject([
      { definitionKey: "leaf", nodeKey: "leaf" },
    ]);
  });

  it("returns detached, immutable JSON-safe projections", () => {
    const definition = new Leaf();
    const first = definition.definition;
    const second = definition.definition;

    expect(first).not.toBe(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.graph)).toBe(true);
  });

  it("detaches nested graph arrays from every projection", () => {
    const definition = new ParentWorkflow();
    const first = definition.definition;
    const second = definition.definition;
    const firstNested = first.graph.children?.[0];
    const secondNested = second.graph.children?.[0];

    expect(firstNested).not.toBe(secondNested);
    expect(firstNested?.children).not.toBe(secondNested?.children);
    expect(Object.isFrozen(firstNested?.children)).toBe(true);
  });

  it("compiles a nested Workflow into the parent runtime tree", async () => {
    const runtime = materializeWorkflow(new ParentWorkflow(), undefined);

    await expect(runtime.run()).resolves.toBe("ok");
    expect(runtime.root.steps["parent.nested"]?.status).toBe("complete");
    expect(runtime.root.steps["parent.nested.leaf"]?.status).toBe("complete");
    expect(runtime.root.steps["nested.leaf"]).toBeUndefined();
  });

  it("keeps presentation metadata out of local identity and preserves dot keys", () => {
    const definition = new DotKeyWorkflow().definition;
    const child = definition.graph.children?.[0];

    expect(definition.definitionKey).toBe("stable.workflow");
    expect(child).toMatchObject({
      definitionKey: "stable.leaf",
      name: "A mutable presentation label",
      nodeKey: "local.segment.with.dots",
    });
    expect(JSON.stringify(definition)).not.toContain("output");
  });
});
