import { describe, expect, it } from "vitest";

import type { DefinitionDescriptor } from "../definitions";

import { Step } from "../step";
import { materializeStep } from "./helpers/definitions";

class DoubleStep extends Step<number, number> {
  readonly definitionKey = "math.double";
  readonly name = "Double number";
  readonly description = "Multiply one input by two.";
  calls = 0;

  protected async execute(input: number): Promise<number> {
    this.calls += 1;
    return input * 2;
  }
}

class BareStep extends Step<void, "ok"> {
  readonly definitionKey = "bare";

  protected async execute(): Promise<"ok"> {
    return "ok";
  }
}

describe("definition-backed Step", () => {
  it("describes a public Step before input without allocating or executing", () => {
    const definition = new DoubleStep();

    const descriptor = definition.definition;

    expect(descriptor).toEqual({
      definitionKey: "math.double",
      description: "Multiply one input by two.",
      graph: {
        definitionKey: "math.double",
        description: "Multiply one input by two.",
        kind: "step",
        name: "Double number",
        nodeKey: "math.double",
      },
      kind: "step",
      name: "Double number",
      schemaVersion: 1,
    } satisfies DefinitionDescriptor);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.graph)).toBe(true);
    expect(definition.calls).toBe(0);
    expect(() => definition.snapshot).toThrow(/no runtime substrate/);
    expect(() => definition.id).toThrow(/do not have a runtime id/);
  });

  it("returns detached immutable descriptor projections", () => {
    const definition = new DoubleStep();
    const first = definition.definition;

    expect(() => {
      (first.graph as { name: string }).name = "mutated";
    }).toThrow();

    expect(definition.definition).toEqual({
      ...first,
      graph: { ...first.graph, name: "Double number" },
    });
  });

  it("omits optional presentation metadata", () => {
    expect(new BareStep().definition).toEqual({
      definitionKey: "bare",
      graph: { definitionKey: "bare", kind: "step", nodeKey: "bare" },
      kind: "step",
      schemaVersion: 1,
    });
  });

  it("materializes fresh isolated runtime Steps", async () => {
    const definition = new DoubleStep();
    const first = materializeStep(definition, 2);
    const second = materializeStep(definition, 3);

    expect(first).not.toBe(second);
    expect(first.id).not.toBe(second.id);
    expect(first.snapshot).not.toBe(second.snapshot);
    expect(first.channels).not.toBe(second.channels);
    expect(first.executable).not.toBe(second.executable);
    expect(first.composer).not.toBe(second.composer);
    await expect(first.run()).resolves.toBe(4);
    await expect(second.run()).resolves.toBe(6);
  });

  it("runs one reusable definition concurrently through fresh runtimes", async () => {
    const definition = new DoubleStep();

    await expect(
      Promise.all([definition.run(4), definition.run(5)])
    ).resolves.toEqual([8, 10]);
    expect(definition.calls).toBe(2);
  });
});
