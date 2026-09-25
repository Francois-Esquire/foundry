import { step, workflow } from "@foundry/quirks";
import { Step } from "@foundry/workflows/step";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { startEngine } from "~/engine";
import { unbound } from "~/lib/bindings";
import { catalog } from "~/lib/catalog";
import { createLog } from "~/lib/log";
import { runs } from "~/lib/run-scope";
import { registerCatalog } from "~/lib/tree";

const RUN_EXPLODE_FAILED_PATTERN = /run "explode" failed/;

afterEach(() => {
  catalog.reset();
  runs.clear();
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
    const records = await engine.runs();

    expect(records).toHaveLength(2);
    expect(records.every((run) => run.step === "shout")).toBe(true);
    expect(records.every((run) => run.status === "complete")).toBe(true);
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
      RUN_EXPLODE_FAILED_PATTERN
    );
    expect(lines).toEqual([
      "[step] explode started",
      "[step] explode failed: boom",
    ]);
    await engine.stop();
  });

  it("prints step start and complete lines with the path, in order", async () => {
    const { lines, print } = collector();
    catalog.bind({
      agents: () => unbound("agents"),
      artifacts: () => unbound("artifacts"),
      log: createLog(() => undefined),
      root: process.cwd(),
      sandboxes: () => unbound("sandboxes"),
      workspaces: () => unbound("workspaces"),
    });
    const text = z.object({ text: z.string() });
    const shout = step()
      .input(text)
      .do(({ input }) => input.text.toUpperCase());
    const join = step()
      .input(z.object({ a: z.string(), b: z.string() }))
      .do(({ input }) => `${input.a}${input.b}`);
    workflow("twice")
      .input(text)
      .do(({ input }) =>
        join({ a: shout({}, input), b: shout({}, { text: "!" }) })
      );
    const engine = await startEngine(registerCatalog, { print });

    await expect(engine.run<string>("twice", { text: "hey" })).resolves.toBe(
      "HEY!"
    );
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
