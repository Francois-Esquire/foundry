import { describe, expect, test } from "vitest";

import type {
  JobRecord,
  QueueRecord,
  RunEvent,
  RunEventType,
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

export type ScopedWorkflowStores = (scope: string) => WorkflowStore;

export interface RecordingWorkflowStores {
  readonly failNextCommit: () => void;
  readonly recorded: () => Promise<readonly RunEvent[]>;
  readonly stores: ScopedWorkflowStores;
}

export type WorkflowStoreMode =
  | { readonly hooked: false }
  | {
      readonly hooked: true;
      readonly recording: () => Promise<RecordingWorkflowStores>;
    };

export function describeWorkflowStore(
  name: string,
  open: () => ScopedWorkflowStores | Promise<ScopedWorkflowStores>,
  mode: WorkflowStoreMode
): void {
  async function store(scope = "scope-a"): Promise<WorkflowStore> {
    return (await open())(scope);
  }

  if (mode.hooked) {
    describeRecordedEvents(name, mode.recording);
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

    test("a write's events change no record, with records or alone", async () => {
      const target = await store();
      const records = everyKind();
      await target.commit({
        ...putAll(records),
        events: [event("run.queued", "rn-a"), event("run.started", "rn-a")],
      });
      await target.commit({ events: [removedEvent("rn-gone")] });

      expect(await contents(target)).toStrictEqual(records);
    });

    test("refuses an event a copy would read less of, and keeps nothing of its write", async () => {
      const target = await store();
      class Unplain {
        readonly type = "run.queued";
      }
      const refusals: [WorkflowStoreWrite, string][] = [
        [
          { events: event("run.queued", "rn-a") as unknown as RunEvent[] },
          "events must be an array",
        ],
        [
          {
            events: [
              event("run.queued", "rn-a"),
              new Unplain() as unknown as RunEvent,
            ],
            putRuns: [run("rn-a")],
          },
          "events[1] must be a plain object",
        ],
        ...unplainEvents().map(
          ([label, value]): [WorkflowStoreWrite, string] => [
            { events: [value as RunEvent], putRuns: [run("rn-a")] },
            label,
          ]
        ),
      ];
      for (const [write, message] of refusals) {
        await expect(target.commit(write)).rejects.toThrow(message);
      }
      expect(await contents(target)).toStrictEqual(EMPTY);
    });

    test("refuses such a write through a transaction's view, and the transaction goes on", async () => {
      const target = await store();
      await transactionOf(target)(async (view) => {
        for (const [label, value] of unplainEvents()) {
          await expect(
            view.commit({
              events: [value as RunEvent],
              putRuns: [run("rn-refused")],
            })
          ).rejects.toThrow(label);
        }
        await view.commit({
          events: [event("run.queued", "rn-kept")],
          putRuns: [run("rn-kept")],
        });
      });

      expect(await target.getRun("rn-refused")).toBeNull();
      expect(await target.getRun("rn-kept")).toStrictEqual(run("rn-kept"));
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

      expect(
        (await target.listRuns({ after: page.next, limit: 10 })).items
      ).toStrictEqual([run("rn-c")]);
      expect(await allRuns(target)).toStrictEqual([run("rn-c")]);
    });

    test("states its durability: a commit is durable, a transaction's view is not", async () => {
      const target = await store();
      expect(target.durability ?? "commit").toBe("commit");
      expect(
        await transactionOf(target)((view) => Promise.resolve(view.durability))
      ).toBe("host");
    });

    test("reads each property of a write once, and keeps what that read gave", async () => {
      const target = await store();
      const reads = new Map<string, number>();
      const once = <T>(property: string, value: T) => ({
        enumerable: true,
        get(): T | undefined {
          const count = (reads.get(property) ?? 0) + 1;
          reads.set(property, count);
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

    test("reads a write's properties by name, a prototype getter or a hidden one too", async () => {
      const target = await store();
      class Write {
        get putRuns() {
          return [run("rn-inherited")];
        }
      }
      const hidden = (id: string) =>
        Object.defineProperty({}, "putRuns", {
          enumerable: false,
          value: [run(id)],
        }) as WorkflowStoreWrite;

      await target.commit(new Write());
      await target.commit(hidden("rn-hidden"));
      await transactionOf(target)(async (view) => {
        await view.commit(hidden("rn-in-view"));
      });

      expect((await allRuns(target)).map((item) => item.id)).toEqual([
        "rn-inherited",
        "rn-hidden",
        "rn-in-view",
      ]);
    });

    test("refuses a list or a record a copy would read less of, and keeps nothing", async () => {
      const target = await store();
      class Run {
        readonly id = "rn-class";
      }
      const refusals: [WorkflowStoreWrite, string][] = [
        [
          { putRuns: new Set([run("rn-set")]) as unknown as RunRecord[] },
          "putRuns must be an array",
        ],
        [
          { putRuns: [run("rn-a"), new Run() as unknown as RunRecord] },
          "putRuns[1] must be a plain object",
        ],
        [
          {
            putRuns: [
              Object.defineProperty(run("rn-hidden-field"), "step", {
                enumerable: false,
                value: "s",
              }),
            ],
          },
          "putRuns[0] must be a plain object",
        ],
        [
          { deleteRuns: [1 as unknown as string] },
          "deleteRuns[0] must be text",
        ],
      ];
      for (const [write, message] of refusals) {
        await expect(target.commit(write)).rejects.toThrow(message);
        await expect(
          transactionOf(target)((view) => view.commit(write))
        ).rejects.toThrow(message);
      }
      await expect(
        target.listRuns({ limit: 1, status: "queued" as never })
      ).rejects.toThrow("status must be an array");
      expect(await contents(target)).toStrictEqual(EMPTY);
    });

    test("shares no byte memory behind an Error's cause", async () => {
      const target = await store();
      const bytes = new Uint8Array(new SharedArrayBuffer(1));
      bytes[0] = 1;
      const holding = {
        ...run("rn-error"),
        failure: new Error("outer", { cause: { bytes } }),
      } as unknown as RunRecord;
      let refusal: unknown;
      try {
        await target.commit({ putRuns: [holding] });
      } catch (error) {
        refusal = error;
      }
      if (refusal !== undefined) {
        expect(String(refusal)).toContain("putRuns[0].failure");
        expect(await target.getRun("rn-error")).toBeNull();
        return;
      }
      bytes[0] = 9;
      const causeOf = (record: RunRecord | null) =>
        (
          (record as unknown as { failure: Error } | null)?.failure.cause as
            | { bytes: Uint8Array }
            | undefined
        )?.bytes;
      const read = causeOf(await target.getRun("rn-error"));
      expect(read?.[0]).toBe(1);
      expect(read?.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      if (read !== undefined) {
        read[0] = 7;
      }
      expect(causeOf(await target.getRun("rn-error"))?.[0]).toBe(1);
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

const REFUSAL = /refused: .*use the view/;

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

function event(
  type: Exclude<RunEventType, "run.removed" | "run.updated">,
  runId: string
): RunEvent {
  return {
    at: "2026-11-15T00:00:00.000Z",
    id: `${type}-${runId}`,
    queueId: "default",
    runId,
    type,
  };
}

function removedEvent(runId: string): RunEvent {
  return {
    at: "2026-11-15T00:00:00.000Z",
    id: `run.removed-${runId}`,
    queueId: "default",
    runId,
    step: "s",
    tags: {},
    type: "run.removed",
  };
}

function unplainArrays(): unknown[][] {
  const hidden: unknown[] = ["tags"];
  Object.defineProperty(hidden, "hidden", { value: () => undefined });
  const symbolic: unknown[] = ["tags"];
  Object.defineProperty(symbolic, Symbol("extra"), {
    enumerable: true,
    value: 1n,
  });
  class Entries extends Array<unknown> {}
  return [hidden, symbolic, Entries.from(["tags"])];
}

function holed(): number[] {
  const values: number[] = [];
  values[1] = 2;
  return values;
}

function unplainEvents(): [string, unknown][] {
  const base = event("run.queued", "rn-a");
  return [
    ["events[0].at must be a plain object", { ...base, at: new Date(0) }],
    ["events[0].extra must be a finite number", { ...base, extra: Number.NaN }],
    ["events[0].extra must be a finite number", { ...base, extra: -0 }],
    ["events[0].extra has no JSON form (bigint)", { ...base, extra: 1n }],
    [
      "events[0].extra has no JSON form (undefined)",
      { ...base, extra: undefined },
    ],
    [
      "events[0].extra has no JSON form (function)",
      { ...base, extra: () => undefined },
    ],
    ["events[0].extra[0] is a hole in an array", { ...base, extra: holed() }],
    ["events[0].extra must be a plain object", { ...base, extra: new Map() }],
    ["events[0] must be a plain object", { ...base, [Symbol("extra")]: 1 }],
    ...unplainArrays().map((array): [string, unknown] => [
      "events[0].extra must be a plain array holding only its entries",
      { ...base, extra: array },
    ]),
  ];
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

function protoRun(): RunRecord {
  const base = JSON.stringify(run("rn-proto")).slice(1, -1);
  return JSON.parse(
    `{${base.replace('"extensions":{}', '"extensions":{"__proto__":{"kept":1}}').replace('"metadata":{}', '"metadata":{"__proto__":{"kept":2}}').replace('"tags":{}', '"tags":{"__proto__":"kept"}')},"__proto__":{"undeclared":true},"archivedBy":"operator"}`
  ) as RunRecord;
}

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

function storedAfter(write: ReturnType<typeof callerWrite>): Contents {
  return structuredClone({
    frames: write.putFrames,
    jobs: write.putJobs,
    queues: write.putQueues,
    runs: write.putRuns,
    suspensions: write.putSuspensions,
  });
}

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

function unreadable(): Record<string, unknown> {
  return Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("unreadable metadata");
    },
  });
}

function mutable<T>(value: T | null | undefined): {
  -readonly [K in keyof T]: T[K];
} {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

function describeRecordedEvents(
  name: string,
  recording: () => Promise<RecordingWorkflowStores>
): void {
  const recorder = async () => {
    const opened = await recording();
    return { ...opened, store: opened.stores("scope-a") };
  };

  describe(`${name} workflow store events handed to the host`, () => {
    test("hands on each commit's events once, in order, and none for a write without", async () => {
      const { recorded, store } = await recorder();
      const first = [event("run.queued", "rn-a"), event("run.started", "rn-a")];
      await store.commit({ events: first, putRuns: [run("rn-a")] });
      await store.commit({ putRuns: [run("rn-a", { step: "next" })] });
      await store.commit({ events: [removedEvent("rn-gone")] });

      expect(await recorded()).toStrictEqual([
        ...first,
        removedEvent("rn-gone"),
      ]);
    });

    test("hands on the events as they were when commit was called", async () => {
      const { recorded, store } = await recorder();
      const events = [event("run.queued", "rn-a")];
      const expected = structuredClone(events);

      const pending = store.commit({ events, putRuns: [run("rn-a")] });
      Object.assign(events[0] ?? {}, { type: "run.failed" });
      events.push(event("run.started", "rn-a"));
      await pending;

      expect(await recorded()).toStrictEqual(expected);
    });

    test("records nothing of a write whose event is not plain JSON", async () => {
      const { recorded, store } = await recorder();
      for (const [label, value] of unplainEvents()) {
        await expect(
          store.commit({ events: [value as RunEvent], putRuns: [run("rn-a")] })
        ).rejects.toThrow(label);
      }
      expect(await store.getRun("rn-a")).toBeNull();
      expect(await recorded()).toStrictEqual([]);
    });

    test("records nothing for a write it refuses", async () => {
      const { recorded, store } = await recorder();

      await expect(
        store.commit({
          events: [event("run.queued", "rn-a")],
          putRuns: [run("rn-a", { metadata: unreadable() })],
        })
      ).rejects.toThrow("unreadable");
      expect(await recorded()).toStrictEqual([]);
    });

    test("runs the hook inside the commit: a throw from it keeps neither the write nor its events", async () => {
      const { failNextCommit, recorded, store } = await recorder();
      failNextCommit();

      await expect(
        store.commit({
          events: [event("run.queued", "rn-a")],
          putRuns: [run("rn-a")],
        })
      ).rejects.toThrow();
      expect(await store.getRun("rn-a")).toBeNull();
      expect(await recorded()).toStrictEqual([]);

      await store.commit({
        events: [event("run.queued", "rn-a")],
        putRuns: [run("rn-a")],
      });
      expect(await recorded()).toStrictEqual([event("run.queued", "rn-a")]);
    });

    test("records a transaction's events only when it is kept", async () => {
      const { recorded, store } = await recorder();
      const transaction = transactionOf(store);

      await expect(
        transaction(async (view) => {
          await view.commit({
            events: [event("run.queued", "rn-dropped")],
            putRuns: [run("rn-dropped")],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      await transaction(async (view) => {
        await view.commit({
          events: [event("run.queued", "rn-a")],
          putRuns: [run("rn-a")],
        });
        await view.commit({ events: [event("run.started", "rn-a")] });
      });

      expect(await recorded()).toStrictEqual([
        event("run.queued", "rn-a"),
        event("run.started", "rn-a"),
      ]);
    });
  });
}
