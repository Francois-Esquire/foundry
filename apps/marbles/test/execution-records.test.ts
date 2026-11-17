import { expect, it } from "vitest";
import type { ToolCallObservation } from "~/lib/execution-record";
import { ExecutionRecords } from "~/lib/execution-records";
import { MemoryExecutionStore } from "~/lib/execution-store";

function engines(count: number) {
  const store = new MemoryExecutionStore();
  const warnings: string[] = [];
  const records = Array.from(
    { length: count },
    () => new ExecutionRecords({ store, warn: (line) => warnings.push(line) })
  );
  return { records, store, warnings };
}

function toolCall(id: string): ToolCallObservation {
  return {
    id,
    kind: "tool-call",
    name: "look",
    sessionId: "se-1",
    startedAt: new Date().toISOString(),
    status: "complete",
  };
}

it("keeps another engine's observations when its own progress write reveals them", async () => {
  const {
    records: [first, second],
  } = engines(2);
  if (!(first && second)) {
    throw new Error("two engines expected");
  }
  const { run } = await first.enqueue({
    kind: "task",
    name: "watched",
    queue: "default",
  });
  await second.load();
  expect(await first.observe(run.id, toolCall("ob-1"))).toBe(true);

  second.progress(run.id, { step: 1 });
  await second.flush();

  expect(second.get(run.id)?.observations.map(({ id }) => id)).toEqual([
    "ob-1",
  ]);
  expect(second.get(run.id)?.progress).toEqual({ step: 1 });
});

it("stores the progress as it was when given, whatever the caller changes after", async () => {
  const {
    records: [engine],
    store,
  } = engines(1);
  if (!engine) {
    throw new Error("an engine expected");
  }
  const { run } = await engine.enqueue({
    kind: "task",
    name: "counting",
    queue: "default",
  });
  const seen: unknown[] = [];
  await engine.subscribe((changed) => {
    seen.push(changed.progress);
  });
  const state = { count: 1 };

  engine.progress(run.id, state);
  state.count = 2;
  engine.progress(run.id, state);
  state.count = 3;
  await engine.flush();

  expect(seen).toEqual([{ count: 1 }, { count: 2 }]);
  expect(engine.get(run.id)?.progress).toEqual({ count: 2 });
  const stored = (await store.get(run.id))?.value as { progress?: unknown };
  expect(stored.progress).toEqual({ count: 2 });
});

it("warns, and saves nothing, for progress that cannot be stored", async () => {
  const {
    records: [engine],
    warnings,
  } = engines(1);
  if (!engine) {
    throw new Error("an engine expected");
  }
  const { run } = await engine.enqueue({
    kind: "task",
    name: "odd",
    queue: "default",
  });

  expect(() => engine.progress(run.id, Number.NaN)).not.toThrow();
  await engine.flush();
  await Promise.resolve();

  expect(warnings).toEqual([
    expect.stringContaining(`execution ${run.id} progress not saved`),
  ]);
  expect(engine.get(run.id)?.progress).toBeUndefined();
});
