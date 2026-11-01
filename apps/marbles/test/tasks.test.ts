import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tasks } from "@foundry/tasks";
import type { TaskEvent } from "@foundry.sh/marbles";
import { observe, tasks } from "@foundry.sh/marbles";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalog } from "~/authoring/catalog";
import { expectHost, setHost } from "~/authoring/runtime";
import type { Engine } from "~/lib/engine";
import { testEngine } from "./helpers/engine";

const NOT_A_SOURCE = /not something Marbles emits/;
const DISPOSED = /host that held these tasks was disposed/;
const LOADING = /not available while its source loads/;

const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
  catalog.reset();
});

/** A host engine over its own state dir, with what the catalog declared. */
function host(state: string): Engine {
  const engine = testEngine({ print: () => undefined, state });
  engines.push(engine);
  setHost(engine);
  return engine;
}

describe("tasks", () => {
  it("is one backlog the package creates and exports", async () => {
    expect(tasks).toBeInstanceOf(Tasks);
    const again = await import("@foundry.sh/marbles");
    expect(again.tasks).toBe(tasks);
  });

  // First, while this file's process has never been a host.
  it("is held in memory in a script no host loaded", async () => {
    const task = await tasks.create({ title: "Scripted" });
    expect((await tasks.get(task.id))?.title).toBe("Scripted");
  });

  it("is the host's workspace tasks, delivered to what the source observes", async () => {
    const seen: TaskEvent[] = [];
    observe(tasks, (payload) => {
      seen.push(payload);
    });
    const state = mkdtempSync(join(tmpdir(), "marbles-tasks-"));
    const engine = host(state);
    await engine.start();

    const task = await tasks.create({ tags: ["review"], title: "Hosted" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.tasks[0]?.after).toEqual(task);
    const written = JSON.parse(readFileSync(join(state, "tasks.json"), "utf8"));
    expect(written.tasks.map((item: { id: string }) => item.id)).toEqual([
      task.id,
    ]);

    // Disposed, the host answers nothing, and nothing falls back to memory.
    await engine.dispose();
    await expect(tasks.create({ title: "Late" })).rejects.toThrow(DISPOSED);
    await expect(tasks.list()).rejects.toThrow(DISPOSED);

    // Loading another workspace's source: still refused.
    expectHost();
    await expect(tasks.list()).rejects.toThrow(LOADING);

    // Bound to that workspace's engine: its own tasks, not the first's.
    const nextState = mkdtempSync(join(tmpdir(), "marbles-tasks-"));
    const next = host(nextState);
    await next.start();
    expect((await tasks.list()).items).toEqual([]);
    const moved = await tasks.create({ title: "Next workspace" });
    expect((await tasks.list()).items.map((item) => item.id)).toEqual([
      moved.id,
    ]);
    const first = JSON.parse(readFileSync(join(state, "tasks.json"), "utf8"));
    expect(first.tasks.map((item: { id: string }) => item.id)).toEqual([
      task.id,
    ]);
  });

  it("observe takes a source and a handler, and nothing else", () => {
    expect(() =>
      // @ts-expect-error A plain Tasks is not something Marbles emits.
      observe(new Tasks(), () => undefined)
    ).toThrow(NOT_A_SOURCE);
    // @ts-expect-error No options.
    observe(tasks, () => undefined, { id: "x" });
    expect(
      observe(tasks, (payload) => {
        // @ts-expect-error The payload is the source's.
        expect(payload.missing).toBeUndefined();
      })
    ).toBeUndefined();
    expect(catalog.observers).toHaveLength(2);
  });
});
