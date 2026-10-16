import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { step } from "~/authoring/builder";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { startEngine } from "../helpers/engine";

const engines: Engine[] = [];
const CHILD_PATH = /^outer\.\$run-1-\d+$/;
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
});

async function question(engine: Engine) {
  await vi.waitFor(async () => {
    expect(
      (await engine.feed()).some(
        (candidate) => candidate.input?.status === "open"
      )
    ).toBe(true);
  });
  const entry = (await engine.feed()).find(
    (item) => item.input?.status === "open"
  );
  if (!entry) {
    throw new Error("Expected an open question");
  }
  return entry;
}

it("nested calls share run identity, reporting, streaming, and suspension", async () => {
  let parsed = 0;
  let completed = 0;
  const once = step("once").do(() => {
    completed += 1;
    return completed;
  });
  const child = step("child")
    .input(
      z.object({
        value: z.string().transform((value) => {
          parsed += 1;
          return value.toUpperCase();
        }),
      })
    )
    .do(async ({ ask, input, report, run, stream }) => {
      report.result({ title: "Nested result" });
      stream.write("nested output");
      return {
        answer: await ask.question({ title: "Continue child?" }),
        input: input.value,
        path: run.path,
        run: run.id,
      };
    });
  step("outer").do(async () => {
    const first = await once.run();
    const result = await child.run({ value: "hello" });
    return { child: result, first };
  });
  const engine = await startEngine({ askable: true });
  engines.push(engine);
  const launched = await engine.launch<{
    first: number;
    child: { answer: string; input: string; path: string[]; run: string };
  }>("outer", {});
  const entry = await question(engine);
  expect(entry.run).toBe(launched.id);
  expect(entry.step).toMatch(CHILD_PATH);
  await engine.answer(entry.id, "yes");
  const result = await launched.result;
  expect(result.child).toEqual({
    answer: "yes",
    input: "HELLO",
    path: entry.step.split("."),
    run: launched.id,
  });
  expect(result.first).toBe(1);
  expect(completed).toBe(1);
  expect(parsed).toBe(1);
  expect(await engine.runs()).toHaveLength(1);
  expect(
    (await engine.feed()).filter((item) => item.title === "Nested result")
  ).toHaveLength(1);
});

it("a parent timeout aborts and settles a nested body", async () => {
  let stopped = false;
  const child = step("waiting-child").do(
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            resolve();
          },
          { once: true }
        );
      })
  );
  step("timed-parent")
    .config({ timeout: 30 })
    .do(() => child.run());
  const engine = await startEngine();
  engines.push(engine);
  await expect(engine.run("timed-parent", {})).rejects.toThrow("timed out");
  expect(stopped).toBe(true);
  expect(engine.scopes.size).toBe(0);
});

it("nested questions recover in the parent run after a restart", async () => {
  const state = await mkdtemp(join(tmpdir(), "marbles-nested-"));
  try {
    const child = step("recover-child").do(({ ask }) =>
      ask.question({ title: "Recover child?" })
    );
    step("recover-parent").do(() => child.run());
    const first = await startEngine({ askable: true, state });
    engines.push(first);
    const launched = await first.launch("recover-parent", {});
    const pending = await question(first);
    await first.stop({ cancel: true });
    await first.dispose();
    const second = await startEngine({ askable: true, state });
    engines.push(second);
    const restored = await question(second);
    expect(restored.id).toBe(pending.id);
    await second.answer(restored.id, "recovered");
    await vi.waitFor(async () =>
      expect((await second.runs())[0]?.status).toBe("complete")
    );
    expect((await second.runs())[0]?.id).toBe(launched.id);
    expect((await second.runs())[0]?.output).toBe("recovered");
    await second.dispose();
  } finally {
    await rm(state, { force: true, recursive: true });
  }
});

it("parallel nested calls resume without restarting a sibling still running", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  const slow = step("slow-nested").do(async () => {
    calls += 1;
    await gate;
    return "slow";
  });
  const asks = step("asking-nested").do(({ ask }) =>
    ask.question({ title: "Parallel child?" })
  );
  step("parallel-parent").do(() => Promise.all([slow.run(), asks.run()]));
  const engine = await startEngine({ askable: true });
  engines.push(engine);
  try {
    const launched = await engine.launch("parallel-parent", {});
    const pending = await question(engine);
    await engine.answer(pending.id, "yes");
    finish();
    await expect(launched.result).resolves.toEqual(["slow", "yes"]);
    expect(calls).toBe(1);
  } finally {
    finish();
  }
});

it("a failing nested sibling stops the others before returning the failure", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let stopped = false;
  const slow = step("cancel-nested").do(
    ({ signal }) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            resolve();
          },
          { once: true }
        );
        entered();
      })
  );
  const fails = step("fail-nested").do(async () => {
    await ready;
    throw new Error("nested failure");
  });
  step("failing-parent").do(() => Promise.all([slow.run(), fails.run()]));
  const engine = await startEngine();
  engines.push(engine);
  await expect(engine.run("failing-parent", {})).rejects.toThrow(
    "nested failure"
  );
  expect(stopped).toBe(true);
  expect(engine.scopes.size).toBe(0);
});

it("answers parallel child questions at their own step paths", async () => {
  const asks = step("parallel-question")
    .input(z.object({ title: z.string() }))
    .do(({ ask, input }) => ask.question({ title: input.title }));
  step("two-questions").do(() =>
    Promise.all([
      asks.run({ title: "First child?" }),
      asks.run({ title: "Second child?" }),
    ])
  );
  const engine = await startEngine({ askable: true });
  engines.push(engine);
  const launched = await engine.launch("two-questions", {});
  const first = await question(engine);
  expect(first.title).toBe("First child?");
  expect(
    (await engine.feed()).filter((item) => item.input?.status === "open")
  ).toHaveLength(1);
  await engine.answer(first.id, "first answer");
  const second = await question(engine);
  expect(second.title).toBe("Second child?");
  await engine.answer(second.id, "second answer");
  await expect(launched.result).resolves.toEqual([
    "first answer",
    "second answer",
  ]);
});

it("pauses and resumes a parent while a dynamic child is running", async () => {
  let calls = 0;
  const child = step("pausable-child").do(async ({ signal }) => {
    calls += 1;
    if (calls === 1) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    }
    return "resumed";
  });
  step("pausable-parent").do(() => child.run());
  const engine = await startEngine();
  engines.push(engine);
  const launched = await engine.launch("pausable-parent", {});
  await vi.waitFor(() => expect(calls).toBe(1));
  expect(engine.pause(launched.id, "pausable-parent")).toBe(true);
  await vi.waitFor(async () =>
    expect((await engine.runs())[0]?.status).toBe("suspended")
  );
  await engine.resume(launched.id, "pausable-parent");
  await expect(launched.result).resolves.toBe("resumed");
  expect(calls).toBe(2);
});
