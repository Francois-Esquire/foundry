import { workflow } from "@foundry/quirks";
import { Step } from "@foundry/workflows/step";
import { afterEach, describe, expect, it } from "vitest";

import { startEngine } from "~/engine";
import { registry } from "~/lib/registry";

afterEach(() => {
  registry.reset();
});

class Shout extends Step<string, string> {
  readonly definitionKey = "test.shout";

  protected execute(input: string): Promise<string> {
    return Promise.resolve(input.toUpperCase());
  }
}

class Explode extends Step<void, never> {
  readonly definitionKey = "test.explode";

  protected execute(): Promise<never> {
    return Promise.reject(new Error("boom"));
  }
}

function collector() {
  const lines: string[] = [];
  return { lines, print: (line: string) => lines.push(line) };
}

describe("startEngine", () => {
  it("dispatches a registered definition and returns its value", async () => {
    const engine = await startEngine(
      (orchestrator) => {
        orchestrator.register("shout", new Shout().factory());
      },
      { print: () => undefined }
    );

    await expect(engine.run<string>("shout", "hello")).resolves.toBe("HELLO");
    await engine.stop();
  });

  it("records every dispatch as a Run", async () => {
    const engine = await startEngine(
      (orchestrator) => {
        orchestrator.register("shout", new Shout().factory());
      },
      { print: () => undefined }
    );

    await engine.run<string>("shout", "one");
    await engine.run<string>("shout", "two");
    const runs = await engine.runs();

    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.step === "shout")).toBe(true);
    expect(runs.every((run) => run.status === "complete")).toBe(true);
    await engine.stop();
  });

  it("surfaces a failed run as a rejection naming the definition", async () => {
    const { lines, print } = collector();
    const engine = await startEngine(
      (orchestrator) => {
        orchestrator.register("explode", new Explode().factory());
      },
      { print }
    );

    await expect(engine.run<never>("explode", undefined)).rejects.toThrow(
      /run "explode" failed/
    );
    expect(lines).toEqual([
      "[step] explode started",
      "[step] explode failed: boom",
    ]);
    await engine.stop();
  });

  it("prints step start and complete lines with the path, in order", async () => {
    const { lines, print } = collector();
    const shout = new Shout();
    workflow<string, string>("twice", (graph) => {
      graph
        .step("a", shout, ({ input }) => input)
        .step("b", shout, ({ a }) => `${a}!`)
        .output(({ b }) => b);
    });
    const engine = await startEngine(
      (orchestrator) => {
        for (const register of registry.definitions.values()) {
          register(orchestrator);
        }
      },
      { print }
    );

    await expect(engine.run<string>("twice", "hey")).resolves.toBe("HEY!");
    expect(lines).toEqual([
      "[step] twice started",
      "[step] twice.a started",
      "[step] twice.a complete",
      "[step] twice.b started",
      "[step] twice.b complete",
      "[step] twice complete",
    ]);
    await engine.stop();
  });
});
