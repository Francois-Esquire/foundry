import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Context } from "~/lib/types";
import { testEngine, testInstances } from "./helpers/engine";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["publication", "cleanup"] as const)(
  "shutdown waits for run %s before releasing its scope",
  async (stage) => {
    const gate = deferred();
    const entered = deferred();
    const instances = testInstances();
    if (stage === "publication") {
      const create = instances.artifacts.create.bind(instances.artifacts);
      vi.spyOn(instances.artifacts, "create").mockImplementation(
        async (input) => {
          entered.resolve();
          await gate.promise;
          return create(input);
        }
      );
    }
    const engine = testEngine(instances);
    engine.define({
      fn: ({ report, run }) => {
        if (stage === "cleanup") {
          engine.scopes
            .get(run.id)
            ?.frames.get(run.path.join("."))
            ?.opened.add({
              async close() {
                entered.resolve();
                await gate.promise;
              },
            });
        }
        report.result({ title: "done" });
        return 42;
      },
      kind: "step",
      name: "probe",
    });
    await engine.start();
    const launched = await engine.launch<number>("probe", {});
    let stopped = false;
    const stopping = engine.stop().then(() => {
      stopped = true;
    });
    try {
      await entered.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);
      expect(engine.scopes.has(launched.id)).toBe(true);
      gate.resolve();
      await stopping;
      expect(await launched.result).toBe(42);
      expect(engine.scopes.size).toBe(0);
      expect((await engine.feed()).map((entry) => entry.title)).toEqual([
        "done",
      ]);
    } finally {
      gate.resolve();
      await stopping;
      await engine.dispose();
    }
  }
);

it.each(["factory", "interactions"] as const)(
  "failed %s recovery releases ownership and leaves the saved run recoverable",
  async (stage) => {
    const state = await mkdtemp(join(tmpdir(), "marbles-lifecycle-"));
    const first = testEngine({ askable: true, state });
    const definition = {
      fn: ({ ask }: Context) => ask.question({ title: "continue?" }),
      kind: "step" as const,
      name: "probe",
    };
    first.define(definition);
    await first.start();
    const launched = await first.launch("probe", {});
    await vi.waitFor(async () =>
      expect((await first.runs())[0]?.status).toBe("suspended")
    );
    await first.stop({ cancel: true });
    await first.dispose();
    const path = join(state, "runs", `${launched.id}.json`);
    const saved = await readFile(path, "utf8");
    const failed = testEngine({ askable: true, state });
    if (stage === "factory") {
      failed.define({
        kind: "workflow",
        name: "probe",
        setup: () => {
          throw new Error("recovery failed");
        },
      });
    } else {
      failed.define(definition);
      vi.spyOn(failed.interactions, "restore").mockRejectedValue(
        new Error("recovery failed")
      );
    }
    const next = testEngine({ askable: true, state });
    next.define(definition);
    try {
      await expect(failed.start()).rejects.toThrow("recovery failed");
      await failed.stop();
      expect(failed.scopes.size).toBe(0);
      const lock = failed.store.lock(`run-${launched.id}`);
      expect("release" in lock).toBe(true);
      if ("release" in lock) {
        lock.release();
      }
      expect(await readFile(path, "utf8")).toBe(saved);
      await next.start();
      expect(next.scopes.has(launched.id)).toBe(true);
      const question = (await next.feed()).find(
        (entry) => entry.input?.status === "open"
      );
      expect(question).toBeDefined();
      if (!question) {
        throw new Error("expected recovered question");
      }
      await next.answer(question.id, "yes");
      await next.stop();
      expect(next.scopes.size).toBe(0);
    } finally {
      await failed.dispose();
      await next.stop({ cancel: true });
      await next.dispose();
      await rm(state, { force: true, recursive: true });
    }
  }
);

it("disposal waits for startup, stops the engine, and closes dependencies once", async () => {
  const engine = testEngine();
  const gate = deferred();
  const entered = deferred();
  vi.spyOn(engine.interactions, "restore").mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
  });
  const close = vi.spyOn(engine.models, "dispose");
  const starting = engine.start();
  await entered.promise;
  let disposed = false;
  const disposing = engine.dispose().then(() => {
    disposed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false);
    expect(close).not.toHaveBeenCalled();
    gate.resolve();
    await starting;
    await disposing;
    await engine.dispose();
    expect(close).toHaveBeenCalledOnce();
    await expect(engine.launch("anything", {})).rejects.toThrow(
      "engine is stopping"
    );
  } finally {
    gate.resolve();
    await disposing;
  }
});
