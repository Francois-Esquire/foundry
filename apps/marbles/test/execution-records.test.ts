import type { JsonValue } from "@foundry/lib/json";
import { afterEach, expect, it } from "vitest";
import type { Engine } from "~/lib/engine";
import { MemoryExecutionStore } from "~/lib/executions/store";
import { testEngine } from "./helpers/engine";
import { gate } from "./helpers/executions";

const engines: Engine[] = [];

afterEach(async () => {
  await Promise.allSettled(engines.splice(0).map((engine) => engine.dispose()));
});

async function reporting(
  report: (progress: (value: JsonValue) => void) => void
) {
  const warnings: string[] = [];
  const store = new MemoryExecutionStore();
  const engine = testEngine({
    executionStore: store,
    print: (line) => warnings.push(line),
  });
  engines.push(engine);
  const reported = gate();
  const finish = gate();
  engine.task({
    name: "counting",
    run: async (_input, { progress }) => {
      report(progress);
      reported.open();
      await finish.opened;
    },
  });
  await engine.start();
  const launched = await engine.launch("counting", {});
  await reported.opened;
  return { engine, finish, launched, store, warnings };
}

it("stores the progress as it was when given, whatever the caller changes after", async () => {
  const state = { count: 1 };
  const { engine, finish, launched, store } = await reporting((progress) => {
    progress(state);
    state.count = 2;
    progress(state);
    state.count = 3;
  });
  finish.open();
  await launched.result;
  await engine.stop();
  expect((await store.get(launched.id))?.progress).toEqual({ count: 2 });
  expect(engine.executions.get(launched.id)?.progress).toEqual({ count: 2 });
});

it("warns, and saves nothing, for progress that cannot be stored", async () => {
  const { engine, finish, launched, warnings } = await reporting((progress) => {
    expect(() => progress(Number.NaN)).not.toThrow();
  });
  finish.open();
  await launched.result;
  expect(warnings).toContainEqual(
    expect.stringContaining(`execution ${launched.id} progress not saved`)
  );
  expect(engine.executions.get(launched.id)?.progress).toBeUndefined();
});
