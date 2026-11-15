import { afterEach, describe, expect, it } from "vitest";
import type {
  ExecutionObservation,
  ExecutionRun,
} from "~/lib/execution-record";
import { parseStored } from "~/lib/execution-record";
import type { ExecutionStore } from "~/lib/execution-store";

/**
 * Where an execution store under test comes from: `store()` makes another
 * over the same state, as a second engine would have. `close` ends
 * whatever the stores were made over.
 */
export interface ExecutionStoreFixture {
  close(): Promise<void>;
  store(): ExecutionStore;
}

/** A queued task run, by id. */
function queued(id: string, extra: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    correlation: { moduleId: "notes" },
    id,
    input: { label: id },
    kind: "task",
    name: "save",
    observations: [],
    owner: { pid: process.pid },
    queue: "system",
    revision: 1,
    sequence: 10,
    status: "queued",
    timestamps: {
      queuedAt: "2026-11-01T09:00:00.000Z",
      updatedAt: "2026-11-01T09:00:00.000Z",
    },
    ...extra,
  };
}

function effect(id: string, status: "running" | "complete" = "complete") {
  return {
    data: { bytes: 1 },
    id,
    kind: "effect",
    startedAt: "2026-11-01T09:00:01.000Z",
    status,
    type: "write",
  } satisfies ExecutionObservation;
}

/** The run `id` as `store` gives it back, read as the domain reads it. */
async function read(
  store: ExecutionStore,
  id: string
): Promise<ExecutionRun | undefined> {
  const stored = await store.get(id);
  return stored && parseStored(stored);
}

/**
 * The contract every `ExecutionStore` keeps, whatever it keeps runs in.
 * `shared` says whether two stores from one fixture see one another's
 * runs, as two engines over one database do.
 */
export function describeExecutionStore(
  name: string,
  open: () => Promise<ExecutionStoreFixture>,
  { shared }: { readonly shared: boolean }
): void {
  describe(name, () => {
    let fixture: ExecutionStoreFixture | undefined;
    const made: ExecutionStore[] = [];
    const store = async () => {
      fixture ??= await open();
      const executions = fixture.store();
      made.push(executions);
      return executions;
    };

    afterEach(async () => {
      for (const executions of made.splice(0)) {
        await executions.close().catch(() => undefined);
      }
      await fixture?.close();
      fixture = undefined;
    });

    it("gives back each record whole, what it holds and what it lacks, in admission order", async () => {
      const executions = await store();
      const settled: ExecutionRun = {
        ...queued("b", { sequence: 5 }),
        error: { code: "Error", message: "it broke" },
        progress: null,
        revision: 4,
        source: "save:notes:1",
        status: "failed",
        timestamps: {
          queuedAt: "2026-11-01T09:00:00.000Z",
          settledAt: "2026-11-01T09:00:03.000Z",
          startedAt: "2026-11-01T09:00:01.000Z",
          updatedAt: "2026-11-01T09:00:03.000Z",
        },
      };
      const { input: _input, ...settledRun } = settled;
      const nullInput = queued("c", { input: null, sequence: 20 });
      expect(await executions.put(queued("a"))).toBe(true);
      expect(await executions.put(settledRun)).toBe(true);
      expect(await executions.put(nullInput)).toBe(true);
      expect(await read(executions, "a")).toEqual(queued("a"));
      expect(await read(executions, "b")).toEqual(settledRun);
      expect(await read(executions, "c")).toEqual(nullInput);
      expect(await read(executions, "none")).toBeUndefined();
      expect(
        (await executions.list()).map((stored) => parseStored(stored)?.id)
      ).toEqual(["b", "a", "c"]);
    });

    it("keeps a record only over a lower revision of itself, and its observations with it", async () => {
      const executions = await store();
      await executions.put(queued("a", { revision: 2 }));
      await executions.observe("a", effect("o"), {
        revision: 3,
        updatedAt: "2026-11-01T09:00:02.000Z",
      });
      expect(
        await executions.put(queued("a", { revision: 3, status: "running" }))
      ).toBe(false);
      expect(await read(executions, "a")).toMatchObject({
        revision: 3,
        status: "queued",
      });
      expect(
        await executions.put(queued("a", { revision: 4, status: "running" }))
      ).toBe(true);
      expect(await read(executions, "a")).toMatchObject({
        observations: [effect("o")],
        revision: 4,
        status: "running",
      });
    });

    it("records an observation by id, moving one recorded again last, and raises its run's revision only upward", async () => {
      const executions = await store();
      await executions.put(queued("a", { revision: 5 }));
      const at = (revision: number) => ({
        revision,
        updatedAt: `2026-11-01T09:00:0${String(revision)}.000Z`,
      });
      expect(await executions.observe("a", effect("x", "running"), at(6))).toBe(
        true
      );
      expect(await executions.observe("a", effect("y"), at(7))).toBe(true);
      expect(await executions.observe("a", effect("x"), at(8))).toBe(true);
      // An observation recorded with a revision behind the record's.
      expect(await executions.observe("a", effect("z"), at(2))).toBe(true);
      const run = await read(executions, "a");
      expect(
        run?.observations.map(({ id, status }) => `${id}:${status}`)
      ).toEqual(["y:complete", "x:complete", "z:complete"]);
      expect(run).toMatchObject({
        revision: 8,
        timestamps: { updatedAt: at(8).updatedAt },
      });
      expect(await executions.observe("none", effect("x"), at(9))).toBe(false);
      expect(await read(executions, "none")).toBeUndefined();
    });

    it("finds a run by its name and source, and forgets a run with its observations", async () => {
      const executions = await store();
      await executions.put(queued("a", { source: "request-1" }));
      await executions.put(
        queued("b", { name: "publish", source: "request-1" })
      );
      expect((await executions.withSource("save", "request-1"))?.id).toBe("a");
      expect((await executions.withSource("publish", "request-1"))?.id).toBe(
        "b"
      );
      expect(await executions.withSource("save", "request-2")).toBeUndefined();
      await executions.observe("a", effect("o"), {
        revision: 2,
        updatedAt: "x",
      });
      await executions.remove("a");
      await executions.remove("none");
      expect(await executions.get("a")).toBeUndefined();
      await executions.put(queued("a"));
      expect((await read(executions, "a"))?.observations).toEqual([]);
    });

    it("keeps each scope's retention gap whole", async () => {
      const executions = await store();
      expect(await executions.gaps()).toEqual([]);
      const gap = {
        removed: 2,
        scope: "notes",
        through: "2026-11-01T09:00:00.000Z",
        updatedAt: "2026-11-02T09:00:00.000Z",
      };
      await executions.putGap(gap);
      await executions.putGap({ ...gap, scope: "host" });
      await executions.putGap({ ...gap, removed: 3 });
      expect(
        [...(await executions.gaps())].sort((a, b) =>
          a.scope.localeCompare(b.scope)
        )
      ).toEqual([
        { ...gap, scope: "host" },
        { ...gap, removed: 3 },
      ]);
    });

    it("keeps what a transaction wrote once it resolves, and nothing of one that rejects", async () => {
      const executions = await store();
      await executions.put(queued("a"));
      await expect(
        executions.transaction(async (view) => {
          await view.remove("a");
          await view.put(queued("b"));
          throw new Error("changed its mind");
        })
      ).rejects.toThrow("changed its mind");
      expect((await executions.list()).map(({ id }) => id)).toEqual(["a"]);
      await executions.transaction(async (view) => {
        expect(await view.get("a")).toBeDefined();
        await view.put(queued("b"));
      });
      expect((await executions.list()).map(({ id }) => id).sort()).toEqual([
        "a",
        "b",
      ]);
    });

    it("owns what it is handed from the call, and refuses what it cannot copy", async () => {
      const executions = await store();
      const run = queued("a") as { status: string };
      const putting = executions.put(run as unknown as ExecutionRun);
      run.status = "running";
      await putting;
      expect((await read(executions, "a"))?.status).toBe("queued");
      await expect(
        executions.put({
          ...queued("b"),
          input: (() => 1) as unknown as ExecutionRun["input"],
        })
      ).rejects.toThrow();
    });

    it.runIf(shared)(
      "lets one transaction at a time read and write, across every store over the same state",
      async () => {
        const first = await store();
        const second = await store();
        await first.put(queued("a"));
        const taking = (over: ExecutionStore) =>
          over.transaction(async (view) => {
            const run = (await view.get("a"))?.value as ExecutionRun;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return await view.put({ ...run, revision: run.revision + 1 });
          });
        const taken = await Promise.all([taking(first), taking(second)]);
        // Each read what the other wrote: both landed, one after the other.
        expect(taken).toEqual([true, true]);
        expect((await read(second, "a"))?.revision).toBe(3);
      }
    );

    it("refuses every call once closed", async () => {
      const executions = await store();
      await executions.close();
      await expect(executions.list()).rejects.toThrow();
      await expect(executions.put(queued("a"))).rejects.toThrow();
      await expect(
        executions.transaction(() => Promise.resolve())
      ).rejects.toThrow();
    });
  });
}
