import { describe, expect, test } from "vitest";

import type {
  JobRecord,
  QueueRecord,
  RunFrame,
  RunRecord,
  SuspensionRecord,
} from "../schema";
import type {
  WorkflowStore,
  WorkflowStorePage,
  WorkflowStorePageQuery,
  WorkflowStoreWrite,
} from "../store/index";

/**
 * Fresh, empty storage, reached one scope at a time. The same scope reaches
 * the same records on every call; two scopes never see each other's. A store
 * that has no scopes keeps one store per scope name.
 */
export type ScopedWorkflowStores = (scope: string) => WorkflowStore;

/**
 * The behaviour every `WorkflowStore` shares, as Vitest tests. `open` returns
 * new, empty storage each time it is called. The host's test file closes
 * whatever `open` opened.
 */
export function describeWorkflowStore(
  name: string,
  open: () => ScopedWorkflowStores | Promise<ScopedWorkflowStores>
): void {
  async function store(scope = "scope-a"): Promise<WorkflowStore> {
    return (await open())(scope);
  }

  describe(`${name} workflow store conformance`, () => {
    test("an empty store holds nothing", async () => {
      const empty = await store();
      expect(await empty.getQueue("default")).toBeNull();
      expect(await empty.getJob("jb-missing")).toBeNull();
      expect(await empty.getRun("rn-missing")).toBeNull();
      expect(await empty.getSuspension("su-missing")).toBeNull();
      expect(await contents(empty)).toStrictEqual(EMPTY);
    });

    test("a commit puts every kind of record, and reads return them exactly", async () => {
      const target = await store();
      const records = everyKind();
      await target.commit(putAll(records));

      expect(await target.getQueue("default")).toStrictEqual(records.queues[0]);
      expect(await target.getJob("jb-a")).toStrictEqual(records.jobs[0]);
      expect(await target.getRun("rn-a")).toStrictEqual(records.runs[0]);
      expect(await target.getRun("rn-b")).toStrictEqual(records.runs[1]);
      expect(await target.getSuspension("su-a")).toStrictEqual(
        records.suspensions[0]
      );
      expect(await contents(target)).toStrictEqual(records);
    });

    test("keeps a Run's undeclared fields and entries named __proto__ as own data", async () => {
      const target = await store();
      const stored = protoRun();
      await target.commit({ putQueues: [queue("default")], putRuns: [stored] });

      const read = await target.getRun(stored.id);
      expect(read).toStrictEqual(stored);
      const fields = read as unknown as Record<string, unknown>;
      expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
      expect(Object.hasOwn(fields, "__proto__")).toBe(true);
      expect(
        Object.getOwnPropertyDescriptor(fields, "__proto__")?.value
      ).toStrictEqual({ undeclared: true });
      expect(Object.hasOwn(fields, "archivedBy")).toBe(true);
      expect(Object.hasOwn(read?.metadata ?? {}, "__proto__")).toBe(true);
      expect(Object.hasOwn(read?.tags ?? {}, "__proto__")).toBe(true);
      expect(Object.hasOwn(read?.extensions ?? {}, "__proto__")).toBe(true);
    });

    test("tells a field left out from one that is null", async () => {
      const target = await store();
      const bare = run("rn-bare");
      const linked = run("rn-linked", {
        definition: { name: "workflow.linked" },
        error: { message: "failed", name: "Error" },
        links: {},
        output: null,
      });
      await target.commit({ putRuns: [bare, linked] });

      const [readBare, readLinked] = await Promise.all([
        target.getRun(bare.id),
        target.getRun(linked.id),
      ]);
      expect(readBare).toStrictEqual(bare);
      expect(Object.hasOwn(readBare ?? {}, "definition")).toBe(false);
      expect(Object.hasOwn(readBare ?? {}, "links")).toBe(false);
      expect(readLinked).toStrictEqual(linked);
      expect(readLinked?.links).toStrictEqual({});
    });

    test("lists records in the order first put; a put over one keeps its place", async () => {
      const target = await store();
      await target.commit({ putRuns: [run("rn-b")] });
      await target.commit({ putRuns: [run("rn-a"), run("rn-c")] });
      const renamed = run("rn-b", { step: "renamed" });
      await target.commit({ putRuns: [renamed] });

      expect(await allRuns(target)).toStrictEqual([
        renamed,
        run("rn-a"),
        run("rn-c"),
      ]);
    });

    test("a later put of one key in a write replaces an earlier one and keeps its place", async () => {
      const target = await store();
      await target.commit({
        putRuns: [run("rn-a"), run("rn-b"), run("rn-a", { step: "again" })],
      });

      expect(await allRuns(target)).toStrictEqual([
        run("rn-a", { step: "again" }),
        run("rn-b"),
      ]);
    });

    test("deletes apply before puts, so a record deleted and put again moves last", async () => {
      const target = await store();
      await target.commit({ putRuns: [run("rn-a"), run("rn-b")] });
      const again = run("rn-a", { step: "again" });
      await target.commit({ deleteRuns: ["rn-a"], putRuns: [again] });

      expect(await allRuns(target)).toStrictEqual([run("rn-b"), again]);
    });

    test("deletes remove only what they name, and missing records are no-ops", async () => {
      const target = await store();
      const records = everyKind();
      await target.commit(putAll(records));
      await target.commit({
        deleteJobs: ["jb-a", "jb-missing"],
        deleteRunFrames: ["rn-a", "rn-missing"],
        deleteRuns: ["rn-b", "rn-missing"],
        deleteSuspensions: ["su-a", "su-missing"],
      });

      // The store enforces nothing: a Run outlives its frames and its Job.
      expect(await contents(target)).toStrictEqual({
        ...records,
        frames: records.frames.filter((item) => item.runId !== "rn-a"),
        jobs: [],
        runs: records.runs.filter((item) => item.id !== "rn-b"),
        suspensions: [],
      });
    });

    test("an empty write changes nothing", async () => {
      const target = await store();
      const records = everyKind();
      await target.commit(putAll(records));
      await target.commit({});
      await target.commit({
        deleteJobs: [],
        deleteRunFrames: [],
        deleteRuns: [],
        deleteSuspensions: [],
        putFrames: [],
        putJobs: [],
        putQueues: [],
        putRuns: [],
        putSuspensions: [],
      });

      expect(await contents(target)).toStrictEqual(records);
    });

    test("a failing commit leaves nothing behind", async () => {
      const target = await store();
      const records = everyKind();
      await target.commit(putAll(records));

      await expect(
        target.commit({
          deleteJobs: ["jb-a"],
          deleteRunFrames: ["rn-a"],
          deleteRuns: ["rn-a"],
          putJobs: [job("jb-new")],
          putRuns: [
            run("rn-new"),
            run("rn-poisoned", { metadata: unreadable() }),
          ],
        })
      ).rejects.toThrow("unreadable");

      expect(await contents(target)).toStrictEqual(records);
    });

    test("reads are detached from the store", async () => {
      const target = await store();
      const records = everyKind();
      await target.commit(putAll(records));

      const read = mutable(await target.getRun("rn-a"));
      read.step = "changed";
      (read.metadata as Record<string, unknown>).added = true;
      const listed = await contents(target);
      mutable(listed.runs[0]).step = "changed";
      mutable(listed.frames[0]).cursor = 99;
      mutable(listed.queues[0]).name = "changed";

      expect(await target.getRun("rn-a")).toStrictEqual(records.runs[0]);
      expect(await contents(target)).toStrictEqual(records);
    });

    test("takes a write as it stands when commit is called, though the caller changes it at once", async () => {
      const target = await store();
      const write = callerWrite();
      const expected = storedAfter(write);

      const landing = target.commit(write);
      scramble(write);
      await landing;

      expect(await contents(target)).toStrictEqual(expected);
    });

    test("takes a write as it stands when commit is called, though it waits behind a transaction", async () => {
      const target = await store();
      const write = callerWrite();
      const expected = storedAfter(write);
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const running = transactionOf(target)(async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;

      const landing = target.commit(write);
      scramble(write);
      held.resolve();
      await Promise.all([running, landing]);

      expect(await contents(target)).toStrictEqual(expected);
    });

    test("takes a write through a transaction's view as it stands when commit is called", async () => {
      const target = await store();
      const write = callerWrite();
      const expected = storedAfter(write);

      await transactionOf(target)(async (view) => {
        const committed = view.commit(write);
        scramble(write);
        await committed;
        expect(await contents(view)).toStrictEqual(expected);
      });

      expect(await contents(target)).toStrictEqual(expected);
    });

    test("takes a list query as it stands when the read is called", async () => {
      const target = await store();
      await target.commit({
        putRuns: [run("rn-a"), run("rn-b", { status: "complete" })],
      });
      const status: RunRecord["status"][] = ["complete"];
      const query = { limit: 10, status };
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const running = transactionOf(target)(async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;

      const reading = target.listRuns(query);
      status[0] = "queued";
      held.resolve();
      await running;

      expect((await reading).items.map((item) => item.id)).toEqual(["rn-b"]);
    });

    test("list reads filter by exact values", async () => {
      const target = await store();
      await target.commit({
        putFrames: [frame("rn-a", 0), frame("rn-b", 0), frame("rn-a", 1)],
        putJobs: [job("jb-a"), job("jb-b", { status: "complete" })],
        putRuns: [
          run("rn-a"),
          run("rn-b", { queueId: "other" }),
          run("rn-c", { status: "complete" }),
        ],
        putSuspensions: [
          suspension("su-a", "rn-a"),
          suspension("su-b", "rn-b"),
          suspension("su-c", "rn-a", {
            resolution: { answer: 1 },
            status: "resolved",
          }),
        ],
      });

      const ids = async (
        page: Promise<WorkflowStorePage<{ readonly id: string }>>
      ) => (await page).items.map((item) => item.id);
      expect(
        await ids(target.listRuns({ limit: 10, queueId: "other" }))
      ).toEqual(["rn-b"]);
      expect(
        await ids(
          target.listRuns({
            limit: 10,
            queueId: "default",
            status: ["queued", "complete"],
          })
        )
      ).toEqual(["rn-a", "rn-c"]);
      expect(await ids(target.listRuns({ limit: 10, status: [] }))).toEqual([]);
      expect(
        await ids(target.listJobs({ limit: 10, status: ["complete"] }))
      ).toEqual(["jb-b"]);
      expect(
        await ids(target.listSuspensions({ limit: 10, runId: "rn-a" }))
      ).toEqual(["su-a", "su-c"]);
      expect(
        await ids(
          target.listSuspensions({
            limit: 10,
            runId: "rn-a",
            status: ["pending"],
          })
        )
      ).toEqual(["su-a"]);
      expect(
        (await target.listFrames({ limit: 10, runId: "rn-a" })).items
      ).toStrictEqual([frame("rn-a", 0), frame("rn-a", 1)]);
      expect(
        (await target.listFrames({ limit: 10, runId: "rn-missing" })).items
      ).toStrictEqual([]);
    });

    test("list reads page by cursor, and a page says whether more follow", async () => {
      const target = await store();
      const runs = Array.from({ length: 7 }, (_, index) =>
        run(`rn-${index}`, { status: index % 2 === 0 ? "queued" : "running" })
      );
      await target.commit({ putRuns: runs });

      const first = await target.listRuns({ limit: 2, status: ["queued"] });
      expect(first.items.map((item) => item.id)).toEqual(["rn-0", "rn-2"]);
      expect(first.next).toBeDefined();
      const second = await target.listRuns({
        after: first.next,
        limit: 2,
        status: ["queued"],
      });
      expect(second.items.map((item) => item.id)).toEqual(["rn-4", "rn-6"]);
      expect(second.next).toBeUndefined();
      expect(await allRuns(target, 1)).toStrictEqual(runs);
    });

    test("a cursor stays valid when the records around it are deleted", async () => {
      const target = await store();
      await target.commit({
        putRuns: [run("rn-a"), run("rn-b"), run("rn-x")],
      });
      const page = await target.listRuns({ limit: 2 });
      expect(page.items.map((item) => item.id)).toEqual(["rn-a", "rn-b"]);
      await target.commit({ deleteRuns: ["rn-a", "rn-b", "rn-x"] });
      await target.commit({ putRuns: [run("rn-c")] });

      // A record put after the deletes lists after the cursor: no position
      // is handed out twice, even once every row past it is gone.
      expect(
        (await target.listRuns({ after: page.next, limit: 10 })).items
      ).toStrictEqual([run("rn-c")]);
      expect(await allRuns(target)).toStrictEqual([run("rn-c")]);
    });

    test("reads each property of a write once, and keeps what that read gave", async () => {
      const target = await store();
      const reads = new Map<string, number>();
      const once = <T>(property: string, value: T) => ({
        enumerable: true,
        get(): T | undefined {
          const count = (reads.get(property) ?? 0) + 1;
          reads.set(property, count);
          // A second read answers differently; a store that asks again
          // would write one thing and report another.
          return count === 1 ? value : undefined;
        },
      });
      const write = (prefix: string) =>
        Object.defineProperties(
          {},
          {
            deleteRuns: once(`${prefix}.deleteRuns`, ["rn-gone"]),
            putFrames: once(`${prefix}.putFrames`, [frame("rn-a", 0)]),
            putJobs: once(`${prefix}.putJobs`, [job("jb-a")]),
            putQueues: once(`${prefix}.putQueues`, [queue("default")]),
            putRuns: once(`${prefix}.putRuns`, [run("rn-a")]),
            putSuspensions: once(`${prefix}.putSuspensions`, [
              suspension("su-a", "rn-a"),
            ]),
          }
        ) as WorkflowStoreWrite;
      await target.commit({ putRuns: [run("rn-gone")] });

      await target.commit(write("direct"));
      await transactionOf(target)((view) => view.commit(write("view")));

      for (const [property, count] of reads) {
        expect([property, count]).toEqual([property, 1]);
      }
      expect(reads.size).toBe(12);
      expect(await contents(target)).toStrictEqual({
        frames: [frame("rn-a", 0)],
        jobs: [job("jb-a")],
        queues: [queue("default")],
        runs: [run("rn-a")],
        suspensions: [suspension("su-a", "rn-a")],
      });
    });

    test("shares no byte memory with a caller, through a commit, a read or a view", async () => {
      const target = await store();
      const bytes = new Uint8Array(new SharedArrayBuffer(2));
      bytes.set([1, 2]);
      const holding = {
        ...run("rn-bytes"),
        archived: { bytes },
      } as unknown as RunRecord;
      let refusal: unknown;
      try {
        await target.commit({ putRuns: [holding] });
      } catch (error) {
        refusal = error;
      }
      if (refusal !== undefined) {
        // A store that cannot keep bytes refuses them, naming the field,
        // and keeps nothing of the write.
        expect(String(refusal)).toContain("putRuns[0].archived.bytes");
        expect(await target.getRun("rn-bytes")).toBeNull();
        return;
      }
      bytes[0] = 9;
      const stored = (record: RunRecord | null) =>
        (record as unknown as { archived: { bytes: Uint8Array } } | null)
          ?.archived.bytes;
      const read = stored(await target.getRun("rn-bytes"));
      expect([...(read ?? [])]).toEqual([1, 2]);
      expect(read?.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      if (read !== undefined) {
        read[1] = 7;
      }
      const [listed] = (await target.listRuns({ limit: 1 })).items;
      expect([...(stored(listed ?? null) ?? [])]).toEqual([1, 2]);
      await transactionOf(target)(async (view) => {
        const seen = stored(await view.getRun("rn-bytes"));
        if (seen !== undefined) {
          seen[0] = 5;
        }
        expect([...(stored(await view.getRun("rn-bytes")) ?? [])]).toEqual([
          1, 2,
        ]);
      });
      expect([...(stored(await target.getRun("rn-bytes")) ?? [])]).toEqual([
        1, 2,
      ]);
    });

    test("list reads refuse a limit or cursor they could not honour alike", async () => {
      const target = await store();
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(target.listRuns({ limit })).rejects.toThrow(RangeError);
      }
      await expect(
        target.listFrames({ after: Number.NaN, limit: 1 })
      ).rejects.toThrow(RangeError);
    });

    test("a Run's frames are keyed by Run and cursor, and deleted together", async () => {
      const target = await store();
      await target.commit({
        putFrames: [frame("rn-a", 0), frame("rn-a", 1), frame("rn-b", 0)],
      });
      const replaced = frame("rn-a", 0, { kind: "progress", value: 0.5 });
      await target.commit({ putFrames: [replaced] });

      expect((await target.listFrames({ limit: 10 })).items).toStrictEqual([
        replaced,
        frame("rn-a", 1),
        frame("rn-b", 0),
      ]);
      await target.commit({ deleteRunFrames: ["rn-a"] });
      expect((await target.listFrames({ limit: 10 })).items).toStrictEqual([
        frame("rn-b", 0),
      ]);
    });

    test("one write can carry thousands of records and deletes", async () => {
      const target = await store();
      const frames = Array.from({ length: 12_000 }, (_, index) =>
        frame(`rn-${index % 3}`, Math.floor(index / 3))
      );
      const runs = Array.from({ length: 3000 }, (_, index) =>
        run(`rn-${index}`)
      );
      const missing = Array.from(
        { length: 40_000 },
        (_, index) => `rn-x${index}`
      );
      await target.commit({ putFrames: frames, putRuns: runs });
      await target.commit({
        deleteRunFrames: [...missing, "rn-1"],
        deleteRuns: [...missing, "rn-2"],
      });

      expect(await allRuns(target, 200)).toHaveLength(2999);
      expect(
        (await allFrames(target)).filter((item) => item.runId === "rn-1")
      ).toEqual([]);
      expect(await allFrames(target)).toHaveLength(8000);
    }, 60_000);

    test("two scopes on one storage never see each other", async () => {
      const stores = await open();
      const [first, second] = [stores("scope-a"), stores("scope-b")];
      const records = everyKind();
      await first.commit(putAll(records));

      expect(await second.getRun("rn-a")).toBeNull();
      expect(await contents(second)).toStrictEqual(EMPTY);

      await second.commit({ putRuns: [run("rn-a", { step: "in b" })] });
      await second.commit({
        deleteJobs: ["jb-a"],
        deleteRunFrames: ["rn-a"],
        deleteRuns: ["rn-a"],
        deleteSuspensions: ["su-a"],
      });

      expect(await contents(first)).toStrictEqual(records);
      expect(await contents(stores("scope-a"))).toStrictEqual(records);
    });

    test("a transaction reads its own commits and returns what its work returns", async () => {
      const target = await store();
      const records = everyKind();
      const result = await transactionOf(target)(async (view) => {
        await view.commit(putAll(records));
        expect(await view.getRun("rn-a")).toStrictEqual(records.runs[0]);
        expect(await contents(view)).toStrictEqual(records);
        return "done";
      });

      expect(result).toBe("done");
      expect(await contents(target)).toStrictEqual(records);
    });

    test("a transaction whose work throws leaves nothing, and the next one runs", async () => {
      const target = await store();
      await target.commit({ putRuns: [run("rn-kept")] });

      await expect(
        transactionOf(target)(async (view) => {
          await view.commit({
            deleteRuns: ["rn-kept"],
            putFrames: [frame("rn-lost", 0)],
            putRuns: [run("rn-lost")],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      expect(await contents(target)).toStrictEqual({
        ...EMPTY,
        runs: [run("rn-kept")],
      });

      await transactionOf(target)((view) =>
        view.commit({ putRuns: [run("rn-lost")] })
      );
      expect(await target.getRun("rn-lost")).toStrictEqual(run("rn-lost"));
    });

    test("a write from outside cannot land between a transaction's read and its commit", async () => {
      const target = await store();
      const original = run("rn-a");
      await target.commit({ putRuns: [original] });
      const outside = run("rn-a", { step: "outside" });
      const inside = run("rn-a", { step: "inside" });
      const read = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();

      const running = transactionOf(target)(async (view) => {
        const before = await view.getRun(original.id);
        read.resolve();
        await proceed.promise;
        const after = await view.getRun(original.id);
        await view.commit({ putRuns: [inside] });
        return { after, before };
      });
      await read.promise;
      // An independent caller, while the transaction sits between its read
      // and its commit, given time enough to land if nothing held it back.
      const landed = target.commit({ putRuns: [outside] });
      await pause(20);
      proceed.resolve();

      expect(await running).toStrictEqual({
        after: original,
        before: original,
      });
      await landed;
      expect(await target.getRun(original.id)).toStrictEqual(outside);
    });

    test("a call to the store from inside its own transaction is refused at once", async () => {
      const target = await store();
      const calls: Record<string, () => Promise<unknown>> = {
        commit: () => target.commit({ putRuns: [run("rn-a")] }),
        getJob: () => target.getJob("jb-a"),
        getQueue: () => target.getQueue("default"),
        getRun: () => target.getRun("rn-a"),
        getSuspension: () => target.getSuspension("su-a"),
        listFrames: () => target.listFrames({ limit: 1 }),
        listJobs: () => target.listJobs({ limit: 1 }),
        listQueues: () => target.listQueues(),
        listRuns: () => target.listRuns({ limit: 1 }),
        listSuspensions: () => target.listSuspensions({ limit: 1 }),
        transaction: () => transactionOf(target)(() => Promise.resolve()),
      };
      const { promise: ended, resolve: end } = Promise.withResolvers<void>();
      let later: Promise<unknown> = Promise.resolve();

      const refusals = await transactionOf(target)(async (view) => {
        const outcomes: Record<string, string> = {};
        for (const [method, call] of Object.entries(calls)) {
          outcomes[method] = await settlesWithin(call(), 1000);
        }
        // Scheduled from inside, but run once the transaction has ended.
        later = ended.then(() => target.commit({ putRuns: [run("rn-a")] }));
        await view.commit({ putRuns: [run("rn-b")] });
        return outcomes;
      });
      end();

      for (const outcome of Object.values(refusals)) {
        expect(outcome).toMatch(REFUSAL);
      }
      await later;
      expect((await allRuns(target)).map((item) => item.id)).toEqual([
        "rn-b",
        "rn-a",
      ]);
    });
  });
}

/** What a store's refusal of a call from inside its own transaction says. */
const REFUSAL = /refused: .*use the view/;

/** Every record a store holds, by kind, in list order. */
interface Contents {
  readonly frames: readonly RunFrame[];
  readonly jobs: readonly JobRecord[];
  readonly queues: readonly QueueRecord[];
  readonly runs: readonly RunRecord[];
  readonly suspensions: readonly SuspensionRecord[];
}

const EMPTY: Contents = {
  frames: [],
  jobs: [],
  queues: [],
  runs: [],
  suspensions: [],
};

/** Every page of one list read, in order, `limit` at a time. */
async function all<T>(
  list: (query: WorkflowStorePageQuery) => Promise<WorkflowStorePage<T>>,
  limit = 50
): Promise<T[]> {
  const items: T[] = [];
  let after: number | undefined;
  for (;;) {
    const page = await list(after === undefined ? { limit } : { after, limit });
    items.push(...page.items);
    if (page.next === undefined) {
      return items;
    }
    after = page.next;
  }
}

function allRuns(store: WorkflowStore, limit?: number): Promise<RunRecord[]> {
  return all((query) => store.listRuns(query), limit);
}

function allFrames(store: WorkflowStore): Promise<RunFrame[]> {
  return all((query) => store.listFrames(query), 1000);
}

async function contents(store: WorkflowStore): Promise<Contents> {
  return {
    frames: await allFrames(store),
    jobs: await all((query) => store.listJobs(query)),
    queues: [...(await store.listQueues())],
    runs: await allRuns(store),
    suspensions: await all((query) => store.listSuspensions(query)),
  };
}

function putAll(records: Contents): WorkflowStoreWrite {
  return {
    putFrames: records.frames,
    putJobs: records.jobs,
    putQueues: records.queues,
    putRuns: records.runs,
    putSuspensions: records.suspensions,
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * How `promise` settled, as `refused: <message>` or `resolved`, or
 * `still pending` after `ms`: a hang becomes a failed assertion, not a
 * stalled suite.
 */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error: unknown) =>
          `refused: ${error instanceof Error ? error.message : String(error)}`
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The store's `transaction`; every store this suite describes has one. */
function transactionOf(
  store: WorkflowStore
): NonNullable<WorkflowStore["transaction"]> {
  const { transaction } = store;
  if (transaction === undefined) {
    throw new Error("the store has no transaction(work)");
  }
  return transaction.bind(store);
}

function queue(id: string, overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    createdAt: 1_700_000_000_000,
    extensions: {},
    id,
    lastError: null,
    name: id,
    status: "active",
    ...overrides,
  };
}

function job(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    definition: { name: "workflow.job" },
    id,
    input: null,
    links: {},
    status: "pending",
    timestamps: {
      cancelledAt: null,
      completedAt: null,
      createdAt: 1_700_000_000_000,
      failedAt: null,
    },
    ...overrides,
  };
}

function run(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    error: null,
    extensions: {},
    id,
    input: null,
    metadata: {},
    output: null,
    queueId: "default",
    snapshot: { cursor: null, input: null, name: "", steps: [] },
    status: "queued",
    step: "workflow.step",
    tags: {},
    timestamps: {
      completedAt: null,
      createdAt: 1_700_000_000_000,
      failedAt: null,
      startedAt: null,
    },
    ...overrides,
  };
}

function suspension(
  id: string,
  runId: string,
  overrides: Partial<SuspensionRecord> = {}
): SuspensionRecord {
  return {
    id,
    kind: "approval",
    name: "approve",
    occurrence: 0,
    reason: "needs a person",
    request: { question: "ok?" },
    resolution: null,
    revision: 0,
    runId,
    status: "pending",
    stepPath: ["approve"],
    timestamps: {
      cancelledAt: null,
      createdAt: 1_700_000_000_000,
      resolvedAt: null,
    },
    ...overrides,
  };
}

function frame(
  runId: string,
  cursor: number,
  payload: RunFrame["payload"] = { kind: "output", value: { cursor } }
): RunFrame {
  return { at: 1_700_000_000_000 + cursor, cursor, payload, runId };
}

/**
 * One of each record, holding every kind of value its columns keep: nested
 * JSON, `null` JSON values, fractional and whole numbers, text beyond
 * ASCII, optional fields present and left out, and a Run field the schema
 * does not declare.
 */
function everyKind(): Contents {
  const running = run("rn-a", {
    definition: { name: "workflow.full", version: "2" },
    error: { message: "boom", name: "Error", stack: "at line 1" },
    extensions: { "host.thing": { list: [1, 2.5, "три", null, true] } },
    input: { nested: { deep: [{ a: 1 }] } },
    links: { invocationId: "inv-1", jobId: "jb-a", sessionId: "sess-1" },
    metadata: { workflow: { status: "running" } },
    output: [1, "two", null],
    snapshot: {
      cursor: "step-a",
      input: { topic: "x" },
      name: "full",
      steps: [
        {
          children: [{ index: 0, key: "a.b", name: "b" }],
          index: 0,
          key: "a",
          name: "a",
        },
      ],
    },
    status: "running",
    tags: { team: "core", 名前: "値" },
    timestamps: {
      completedAt: null,
      createdAt: 1_700_000_000_000.5,
      failedAt: null,
      startedAt: 1_700_000_000_001,
    },
  });
  return {
    frames: [
      frame("rn-a", 0),
      frame("rn-a", 1, { kind: "progress", value: 0.25 }),
      frame("rn-b", 0, {
        kind: "suspension",
        value: suspension("su-b", "rn-b"),
      }),
    ],
    jobs: [
      job("jb-a", {
        definition: { name: "workflow.full", version: "2" },
        input: { list: [null], prompt: "draft" },
        links: { sessionId: "sess-1", subjectId: "doc-1" },
        status: "active",
      }),
    ],
    queues: [
      queue("default", {
        extensions: { "host.queue": { region: "eu" } },
        lastError: { message: "stalled", name: "QueueError" },
      }),
      queue("other", { status: "paused" }),
    ],
    runs: [
      running,
      { ...run("rn-b"), archivedBy: "operator" } as unknown as RunRecord,
    ],
    suspensions: [
      suspension("su-a", "rn-a", {
        request: null,
        resolution: { approved: true },
        revision: 1,
        status: "resolved",
        timestamps: {
          cancelledAt: null,
          createdAt: 1_700_000_000_000,
          resolvedAt: 1_700_000_000_002,
        },
      }),
    ],
  };
}

/**
 * A Run built from JSON, so each `__proto__` key is an own data property:
 * one at the top of the record, undeclared, and one in each dictionary.
 */
function protoRun(): RunRecord {
  const base = JSON.stringify(run("rn-proto")).slice(1, -1);
  return JSON.parse(
    `{${base.replace('"extensions":{}', '"extensions":{"__proto__":{"kept":1}}').replace('"metadata":{}', '"metadata":{"__proto__":{"kept":2}}').replace('"tags":{}', '"tags":{"__proto__":"kept"}')},"__proto__":{"undeclared":true},"archivedBy":"operator"}`
  ) as RunRecord;
}

/**
 * A write as a caller holds it: records of each kind to put and an empty
 * list of each delete, every part of it open to change.
 */
function callerWrite() {
  return {
    deleteJobs: [] as string[],
    deleteRunFrames: [] as string[],
    deleteRuns: [] as string[],
    deleteSuspensions: [] as string[],
    putFrames: [frame("rn-a", 0)],
    putJobs: [job("jb-a", { input: { list: ["x"] } })],
    putQueues: [queue("default")],
    putRuns: [run("rn-a", { metadata: { list: ["x"] } })],
    putSuspensions: [suspension("su-a", "rn-a")],
  };
}

/** What a store holds once `write`, as it stands now, lands in an empty store. */
function storedAfter(write: ReturnType<typeof callerWrite>): Contents {
  return structuredClone({
    frames: write.putFrames,
    jobs: write.putJobs,
    queues: write.putQueues,
    runs: write.putRuns,
    suspensions: write.putSuspensions,
  });
}

/**
 * Changes, in place, every value `write` holds, as a caller might once
 * `commit` has returned: a field of each record it puts and the values
 * nested in them, a further record of each kind, and a delete of each.
 */
function scramble(write: ReturnType<typeof callerWrite>): void {
  mutable(write.putFrames[0]).cursor = 7;
  (mutable(write.putJobs[0]).input as { list: string[] }).list.push("changed");
  mutable(write.putQueues[0]).name = "changed";
  mutable(write.putRuns[0]).step = "changed";
  (mutable(write.putRuns[0]).metadata.list as string[]).push("changed");
  mutable(write.putSuspensions[0]).reason = "changed";
  write.putFrames.push(frame("rn-late", 0));
  write.putJobs.push(job("jb-late"));
  write.putQueues.push(queue("late"));
  write.putRuns.push(run("rn-late"));
  write.putSuspensions.push(suspension("su-late", "rn-a"));
  write.deleteJobs.push("jb-a");
  write.deleteRunFrames.push("rn-a");
  write.deleteRuns.push("rn-a");
  write.deleteSuspensions.push("su-a");
}

/** Metadata that throws when read, so no store can copy or encode it. */
function unreadable(): Record<string, unknown> {
  return Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("unreadable metadata");
    },
  });
}

/** Drops `readonly` so a test can try to change what a store handed out. */
function mutable<T>(value: T | null | undefined): {
  -readonly [K in keyof T]: T[K];
} {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}
