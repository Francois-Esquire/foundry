import { thisProcess } from "@foundry/lib/process-identity";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExecutionObservation,
  ExecutionRun,
} from "~/lib/execution-record";
import { parseStored } from "~/lib/execution-record";
import type { ExecutionStore, LifecycleChange } from "~/lib/execution-store";

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
    owner: thisProcess(),
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

/** A process that does not own the runs here. */
const OTHER = { pid: 2_147_483_646, started: null } as const;
const AT = "2026-11-01T09:00:01.000Z";
const LATER = "2026-11-01T09:00:09.000Z";

/** A start of a run this process owns: from queued, its input dropped. */
function start(extra: Partial<LifecycleChange> = {}): LifecycleChange {
  return {
    dropInput: true,
    from: ["queued"],
    owner: thisProcess(),
    startedAt: AT,
    status: "running",
    updatedAt: AT,
    ...extra,
  };
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
      expect(await executions.create(queued("a"))).toBe(true);
      expect(await executions.create(settledRun)).toBe(true);
      expect(await executions.create(nullInput)).toBe(true);
      expect(await read(executions, "a")).toEqual(queued("a"));
      expect(await read(executions, "b")).toEqual(settledRun);
      expect(await read(executions, "c")).toEqual(nullInput);
      expect(await read(executions, "none")).toBeUndefined();
      expect(
        (await executions.list()).map((stored) => parseStored(stored)?.id)
      ).toEqual(["b", "a", "c"]);
      // A run of an id kept already is never created over it.
      expect(await executions.create(queued("a", { status: "running" }))).toBe(
        false
      );
      expect((await read(executions, "a"))?.status).toBe("queued");
    });

    it("makes a lifecycle change only from a status it allows and for the owner it names, writing only the lifecycle fields", async () => {
      const executions = await store();
      await executions.create(queued("a", { progress: { step: 1 } }));
      await executions.observe("a", effect("o"), "2026-11-01T09:00:01.000Z");
      // A status it does not allow, and an owner that does not own it.
      expect(
        await executions.transition("a", start({ from: ["running"] }))
      ).toMatchObject({ applied: false, record: { status: "queued" } });
      expect(
        await executions.transition("a", start({ owner: OTHER }))
      ).toMatchObject({ applied: false, record: { status: "queued" } });
      expect(await read(executions, "a")).toMatchObject({ revision: 2 });

      const started = await executions.transition("a", start());
      expect(started).toMatchObject({
        applied: true,
        record: { revision: 3, status: "running" },
      });
      const running = await read(executions, "a");
      expect(running).toMatchObject({
        observations: [effect("o")],
        progress: { step: 1 },
        revision: 3,
        status: "running",
        timestamps: { startedAt: AT },
      });
      expect(running).not.toHaveProperty("input");

      const settled = await executions.transition("a", {
        error: { code: "Error", message: "it broke" },
        from: ["running"],
        newOwner: OTHER,
        owner: thisProcess(),
        settledAt: LATER,
        startedAt: LATER,
        status: "failed",
        updatedAt: LATER,
      });
      expect(settled.applied).toBe(true);
      expect(await read(executions, "a")).toMatchObject({
        error: { code: "Error", message: "it broke" },
        owner: OTHER,
        progress: { step: 1 },
        revision: 4,
        status: "failed",
        // A start is recorded once.
        timestamps: { settledAt: LATER, startedAt: AT, updatedAt: LATER },
      });
      expect(await executions.transition("none", start())).toEqual({
        applied: false,
        record: undefined,
      });
    });

    it("lets advisory changes between a transition's read and its write not block it", async () => {
      const executions = await store();
      await executions.create(queued("a"));
      await executions.transition("a", start());
      // What a settler last read of it, then progress and an observation land.
      const read1 = await read(executions, "a");
      await executions.advise("a", { progress: { n: 1 }, updatedAt: LATER });
      await executions.observe("a", effect("o"), LATER);
      const settled = await executions.transition("a", {
        dropInput: true,
        from: ["queued", "running", "suspended"],
        owner: thisProcess(),
        settledAt: LATER,
        status: "complete",
        updatedAt: LATER,
      });
      expect(settled).toMatchObject({
        applied: true,
        record: { progress: { n: 1 }, status: "complete" },
      });
      expect((read1?.revision ?? 0) + 3).toBe(
        (await read(executions, "a"))?.revision
      );
    });

    it("drops an advisory change on a settled run, and never writes a lifecycle field with one", async () => {
      const executions = await store();
      await executions.create(queued("a"));
      expect(
        await executions.advise("a", { progress: { n: 1 }, updatedAt: LATER })
      ).toMatchObject({
        applied: true,
        record: { progress: { n: 1 }, revision: 2, status: "queued" },
      });
      await executions.transition("a", {
        dropInput: true,
        from: ["queued"],
        owner: thisProcess(),
        settledAt: LATER,
        status: "complete",
        updatedAt: LATER,
      });
      const settled = await read(executions, "a");
      expect(
        await executions.advise("a", { progress: { n: 2 }, updatedAt: "late" })
      ).toMatchObject({ applied: false, record: { status: "complete" } });
      expect(
        await executions.observe("a", effect("late"), "late")
      ).toMatchObject({ applied: false, record: { status: "complete" } });
      expect(await read(executions, "a")).toEqual(settled);
      expect(
        await executions.advise("none", { progress: 1, updatedAt: "late" })
      ).toEqual({ applied: false, record: undefined });
    });

    it("records an observation by id, moving one recorded again last, each raising its run's revision by one", async () => {
      const executions = await store();
      await executions.create(queued("a", { revision: 5 }));
      const at = (second: number) => `2026-11-01T09:00:0${String(second)}.000Z`;
      expect(
        (await executions.observe("a", effect("x", "running"), at(6))).applied
      ).toBe(true);
      expect((await executions.observe("a", effect("y"), at(7))).applied).toBe(
        true
      );
      expect((await executions.observe("a", effect("x"), at(8))).applied).toBe(
        true
      );
      const run = await read(executions, "a");
      expect(
        run?.observations.map(({ id, status }) => `${id}:${status}`)
      ).toEqual(["y:complete", "x:complete"]);
      expect(run).toMatchObject({
        revision: 8,
        timestamps: { updatedAt: at(8) },
      });
      expect(await executions.observe("none", effect("x"), at(9))).toEqual({
        applied: false,
        record: undefined,
      });
    });

    it("finds a run by its name and source, and forgets a run with its observations", async () => {
      const executions = await store();
      await executions.create(queued("a", { source: "request-1" }));
      await executions.create(
        queued("b", { name: "publish", source: "request-1" })
      );
      expect((await executions.withSource("save", "request-1"))?.id).toBe("a");
      expect((await executions.withSource("publish", "request-1"))?.id).toBe(
        "b"
      );
      expect(await executions.withSource("save", "request-2")).toBeUndefined();
      await executions.observe("a", effect("o"), "x");
      await executions.remove("a");
      await executions.remove("none");
      expect(await executions.get("a")).toBeUndefined();
      await executions.create(queued("a"));
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
      await executions.create(queued("a"));
      await expect(
        executions.transaction(async (view) => {
          await view.remove("a");
          await view.create(queued("b"));
          throw new Error("changed its mind");
        })
      ).rejects.toThrow("changed its mind");
      expect((await executions.list()).map(({ id }) => id)).toEqual(["a"]);
      await executions.transaction(async (view) => {
        expect(await view.get("a")).toBeDefined();
        await view.create(queued("b"));
        await view.transition("a", start());
      });
      expect((await executions.list()).map(({ id }) => id).sort()).toEqual([
        "a",
        "b",
      ]);
      expect((await read(executions, "a"))?.status).toBe("running");
    });

    it("reads, inside a transaction, what it wrote so far, and keeps none of it when its work rejects", async () => {
      const executions = await store();
      await executions.create(queued("a", { source: "request-1" }));
      await executions.create(queued("b", { sequence: 11 }));
      await executions.observe("a", effect("o-1"), AT);
      const gap = {
        removed: 1,
        scope: "notes",
        through: AT,
        updatedAt: AT,
      };
      await executions.putGap(gap);
      const before = await executions.list();

      await expect(
        executions.transaction(async (view) => {
          await view.transition("a", start());
          await view.advise("a", { progress: { n: 1 }, updatedAt: LATER });
          await view.observe("a", effect("o-2"), LATER);
          await view.remove("b");
          await view.create(queued("c", { sequence: 12 }));
          await view.putGap({ ...gap, removed: 5 });
          const a = await view.get("a");
          expect(a && parseStored(a)).toMatchObject({
            observations: [effect("o-1"), effect("o-2")],
            progress: { n: 1 },
            revision: 5,
            status: "running",
          });
          expect((await view.list()).map(({ id }) => id)).toEqual(["a", "c"]);
          expect((await view.withSource("save", "request-1"))?.id).toBe("a");
          expect(await view.gaps()).toEqual([{ ...gap, removed: 5 }]);
          throw new Error("changed its mind");
        })
      ).rejects.toThrow("changed its mind");

      expect(await executions.list()).toEqual(before);
      expect(await executions.gaps()).toEqual([gap]);
    });

    it("owns what it is handed from the call, and refuses what it cannot copy", async () => {
      const executions = await store();
      const run = queued("a") as { status: string };
      const creating = executions.create(run as unknown as ExecutionRun);
      run.status = "running";
      await creating;
      expect((await read(executions, "a"))?.status).toBe("queued");
      await expect(
        executions.create({
          ...queued("b"),
          input: (() => 1) as unknown as ExecutionRun["input"],
        })
      ).rejects.toThrow();
    });

    it("keeps a run, its observations and gaps as JSON gives them back, and refuses what JSON would not", async () => {
      const executions = await store();
      await executions.create(
        queued("a", {
          input: { gone: undefined, n: -0 } as unknown as ExecutionRun["input"],
        })
      );
      await executions.advise("a", { progress: { at: -0 }, updatedAt: "t" });
      await executions.observe(
        "a",
        { ...effect("o"), data: { bytes: -0 }, errorCode: undefined },
        "2026-11-01T09:00:02.000Z"
      );
      await executions.putGap({
        removed: -0,
        scope: "host",
        through: "t",
        updatedAt: "t",
      });
      const kept = await read(executions, "a");
      expect(kept?.input).toStrictEqual({ n: 0 });
      expect(kept?.progress).toStrictEqual({ at: 0 });
      expect(kept?.observations).toStrictEqual([
        { ...effect("o"), data: { bytes: 0 } },
      ]);
      expect(await executions.gaps()).toStrictEqual([
        { removed: 0, scope: "host", through: "t", updatedAt: "t" },
      ]);
      await expect(
        executions.create(queued("b", { input: { n: Number.NaN } }))
      ).rejects.toThrow("NaN");
      await expect(
        executions.observe(
          "a",
          { ...effect("p"), data: { n: Number.NEGATIVE_INFINITY } },
          "x"
        )
      ).rejects.toThrow("Infinity");
      await expect(
        executions.advise("a", {
          progress: [undefined] as never,
          updatedAt: "x",
        })
      ).rejects.toThrow("undefined");
      expect((await executions.list()).map(({ id }) => id)).toEqual(["a"]);
      expect(await read(executions, "a")).toMatchObject({
        observations: [{ id: "o" }],
        progress: { at: 0 },
      });
    });

    it.runIf(shared)(
      "lets one of two engines racing to make the same lifecycle change make it, and the other's advisory changes never block or undo it",
      async () => {
        const first = await store();
        const second = await store();
        await first.create(queued("a"));
        const [one, two] = await Promise.all([
          first.transition("a", start()),
          second.transition("a", start()),
        ]);
        expect([one.applied, two.applied].sort()).toEqual([false, true]);
        // The other engine reports progress while the owner settles.
        await second.advise("a", { progress: { n: 1 }, updatedAt: LATER });
        const settled = await first.transition("a", {
          dropInput: true,
          from: ["running"],
          owner: thisProcess(),
          settledAt: LATER,
          status: "complete",
          updatedAt: LATER,
        });
        await second.advise("a", { progress: { n: 2 }, updatedAt: LATER });
        expect(settled.applied).toBe(true);
        expect(await read(second, "a")).toMatchObject({
          progress: { n: 1 },
          status: "complete",
        });
      }
    );

    it("refuses every call once closed", async () => {
      const executions = await store();
      await executions.close();
      await expect(executions.list()).rejects.toThrow();
      await expect(executions.create(queued("a"))).rejects.toThrow();
      await expect(
        executions.transaction(() => Promise.resolve())
      ).rejects.toThrow();
    });
  });
}
