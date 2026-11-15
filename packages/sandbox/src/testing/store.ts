/**
 * The behaviour every {@link ContainerStore} shares. A store package runs it
 * against each store it ships.
 */
import { describe, expect, it } from "vitest";

import type { ContainerRow, SandboxEvent } from "../schema";
import type { ContainerStore } from "../store/index";

/**
 * Fresh, empty storage, reached one scope at a time. The same scope reaches
 * the same rows on every call; two scopes never see each other's. A store
 * that has no scopes keeps one store per scope name.
 */
export type ScopedContainerStores = (scope: string) => ContainerStore;

/**
 * Fresh, empty storage whose stores hand each commit's write to a host hook
 * (a SQLite store's `onCommit`), and a record the hook keeps: it writes the
 * write's events, in order, in the commit's own transaction.
 */
export interface RecordingContainerStores {
  /** Makes the hook throw on its next call, after it has recorded. */
  readonly failNextCommit: () => void;
  /** The events recorded by every commit that was kept, in the order kept. */
  readonly recorded: () => Promise<readonly SandboxEvent[]>;
  readonly stores: ScopedContainerStores;
}

const AT = "2026-01-01T00:00:00.000Z";

function event(type: SandboxEvent["type"], containerId: string): SandboxEvent {
  return { at: AT, containerId, id: `${type}-${containerId}`, type };
}

function row(id: string, fields: Partial<ContainerRow> = {}): ContainerRow {
  return {
    createdAt: 1,
    id,
    nativeId: undefined,
    spec: "{}",
    status: "starting",
    updatedAt: 1,
    ...fields,
  };
}

function ids(rows: readonly ContainerRow[]): string[] {
  return rows.map((item) => item.id);
}

type Transaction = NonNullable<ContainerStore["transaction"]>;

/** The store's transaction, or the test skipped as not applicable. */
function transactionOf(
  store: ContainerStore,
  skip: (note: string) => never
): Transaction {
  const { transaction } = store;
  return transaction === undefined
    ? skip("the store offers no transaction")
    : transaction.bind(store);
}

/** Ids whose second element throws when read, after the first was taken. */
function unreadableSecond(values: readonly [string, string]): string[] {
  const list = [values[0]];
  Object.defineProperty(list, 1, {
    enumerable: true,
    get(): string {
      throw new Error("id cannot be read");
    },
  });
  return list;
}

/**
 * A store holding row `kept`, and a write as a caller holds it: one row to
 * put beside it and no deletes, with the rows the store should list once
 * the write lands as it stood at the call. `scramble` changes, in place,
 * everything the write holds, as a caller might once `commit` has
 * returned: every field of the row it puts, a further row put, and `kept`
 * deleted.
 */
async function callerWrite(target: ContainerStore) {
  const kept = row("kept");
  await target.commit({ putContainers: [kept] });
  const put = row("put", { nativeId: undefined });
  const write = { deleteContainers: [] as string[], putContainers: [put] };
  const expected = [kept, { ...put }];
  const scramble = () => {
    Object.assign(put, {
      createdAt: 2,
      nativeId: "changed",
      spec: '{"changed":true}',
      status: "failed",
      updatedAt: 2,
    });
    write.putContainers.push(row("late"));
    write.deleteContainers.push(kept.id);
  };
  return { expected, scramble, write };
}

/** Lets every other queued callback run, so a missing exclusion would show. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a store's refusal of a call from inside its own transaction says. */
const REFUSAL = /refused: .*use the view/;

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

/**
 * Registers the suite. `open` returns new, empty storage each time it is
 * called. A store with a host hook passes `recording` too, which opens it
 * with one, and the suite also proves the hook is handed each commit's
 * events. The host's test file closes whatever `open` opened.
 */
export function describeContainerStore(
  name: string,
  open: () => ScopedContainerStores | Promise<ScopedContainerStores>,
  recording?: () => Promise<RecordingContainerStores>
): void {
  async function store(scope = "scope-a"): Promise<ContainerStore> {
    return (await open())(scope);
  }

  describe(`${name} container store events`, () => {
    it("keeps no event: a write's events change no row", async () => {
      const target = await store();
      await target.commit({
        events: [event("sandbox.created", "c1")],
        putContainers: [row("c1")],
      });
      await target.commit({ events: [event("sandbox.failed", "c1")] });

      expect(await target.list()).toEqual([row("c1")]);
    });
  });

  if (recording !== undefined) {
    describeRecordedEvents(name, recording);
  }

  describe(`${name} container store conformance`, () => {
    it("starts empty", async () => {
      const empty = await store();
      expect(await empty.list()).toEqual([]);
      expect(await empty.get("c1")).toBeUndefined();
    });

    it("reads back every field of a row it keeps, exactly", async () => {
      const target = await store();
      const before = row("c1");
      const after = row("c2", {
        createdAt: 1_700_000_000_000,
        nativeId: "c2-1",
        spec: '{"format":"foundry.sandbox.container/1","env":{"A":"é ✓ 𝄞"}}',
        status: "running",
        updatedAt: 1_700_000_000_000.5,
      });
      const edges = row("c3", {
        createdAt: -Number.MAX_SAFE_INTEGER,
        nativeId: "",
        spec: "",
        status: "missing",
        updatedAt: Number.MAX_SAFE_INTEGER,
      });
      await target.commit({ putContainers: [before, after, edges] });
      // Strict: an `undefined` field keeps its key, as the row holds it.
      expect(await target.get("c1")).toStrictEqual(before);
      expect(await target.get("c2")).toStrictEqual(after);
      expect(await target.get("c3")).toStrictEqual(edges);
      expect(await target.list()).toStrictEqual([before, after, edges]);
    });

    it("replaces a row put under an id it already holds", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("c1")] });
      const next = row("c1", {
        nativeId: "c1-1",
        status: "stopped",
        updatedAt: 2,
      });
      await target.commit({ putContainers: [next] });
      expect(await target.get("c1")).toStrictEqual(next);
      expect(await target.list()).toStrictEqual([next]);

      // And back: a native id put as `undefined` reads back as `undefined`.
      const cleared = { ...next, nativeId: undefined };
      await target.commit({ putContainers: [cleared] });
      expect(await target.get("c1")).toStrictEqual(cleared);
    });

    it("lists rows in the order first put; a put over one keeps its place", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("b")] });
      await target.commit({ putContainers: [row("a"), row("c")] });
      await target.commit({
        putContainers: [row("b", { status: "running" }), row("d")],
      });
      expect(ids(await target.list())).toEqual(["b", "a", "c", "d"]);
    });

    it("keeps the last of one id put twice in a write, in the first one's place", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("a")] });
      const last = row("b", { status: "running", updatedAt: 2 });
      await target.commit({
        putContainers: [row("b"), row("c"), last, row("a", { updatedAt: 3 })],
      });
      expect(await target.list()).toStrictEqual([
        row("a", { updatedAt: 3 }),
        last,
        row("c"),
      ]);
    });

    it("applies deletes before puts, so a row deleted and put again moves last", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("a"), row("b"), row("c")] });
      const next = row("a", { status: "running", updatedAt: 2 });
      await target.commit({ deleteContainers: ["a"], putContainers: [next] });
      expect(await target.get("a")).toStrictEqual(next);
      expect(ids(await target.list())).toEqual(["b", "c", "a"]);
    });

    it("deletes rows and ignores ids it does not hold", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("c1"), row("c2")] });
      await target.commit({ deleteContainers: ["c1", "missing"] });
      expect(await target.get("c1")).toBeUndefined();
      expect(ids(await target.list())).toEqual(["c2"]);
    });

    it("accepts an empty write", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("c1")] });
      await target.commit({});
      await target.commit({ deleteContainers: [], putContainers: [] });
      expect(await target.list()).toStrictEqual([row("c1")]);
    });

    it("keeps nothing from a write that fails", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("kept")] });
      // Every store copies the whole write when commit is called, so a
      // `spec` that throws on read fails a write that also carries a delete
      // and a valid put, before either is applied. A store that runs
      // statements should also fail a commit partway through its statements
      // in its own tests.
      const unreadable = row("bad");
      Object.defineProperty(unreadable, "spec", {
        enumerable: true,
        get(): string {
          throw new Error("spec cannot be read");
        },
      });
      await expect(
        target.commit({
          deleteContainers: ["kept"],
          putContainers: [row("c1"), unreadable],
        })
      ).rejects.toThrow("spec cannot be read");
      expect(await target.list()).toStrictEqual([row("kept")]);
      expect(await target.get("c1")).toBeUndefined();
    });

    it("keeps every row of a write that fails while reading its deletes", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("a"), row("b")] });
      await expect(
        target.commit({
          deleteContainers: unreadableSecond(["a", "b"]),
          putContainers: [row("c1")],
        })
      ).rejects.toThrow("id cannot be read");
      expect(ids(await target.list())).toEqual(["a", "b"]);
    });

    it("keeps none of a failed commit that a transaction catches", async ({
      skip,
    }) => {
      const target = await store();
      const transaction = transactionOf(target, skip);
      await target.commit({ putContainers: [row("a"), row("b")] });
      await transaction(async (view) => {
        await view.commit({ putContainers: [row("c1")] });
        await expect(
          view.commit({
            deleteContainers: unreadableSecond(["a", "b"]),
            putContainers: [row("c2")],
          })
        ).rejects.toThrow();
        expect(ids(await view.list())).toEqual(["a", "b", "c1"]);
      });
      expect(ids(await target.list())).toEqual(["a", "b", "c1"]);
    });

    it("detaches the rows it is given from the rows it keeps", async () => {
      const target = await store();
      const input = { ...row("c1") };
      await target.commit({ putContainers: [input] });
      input.status = "failed";
      expect((await target.get("c1"))?.status).toBe("starting");
    });

    it("takes a write as it stands when commit is called, though the caller changes it at once", async () => {
      const target = await store();
      const { expected, scramble, write } = await callerWrite(target);

      const landing = target.commit(write);
      scramble();
      await landing;

      expect(await target.list()).toStrictEqual(expected);
    });

    it("takes a write as it stands when commit is called, though it waits behind a transaction", async ({
      skip,
    }) => {
      const target = await store();
      const transaction = transactionOf(target, skip);
      const { expected, scramble, write } = await callerWrite(target);
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const running = transaction(async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;

      const landing = target.commit(write);
      scramble();
      held.resolve();
      await Promise.all([running, landing]);

      expect(await target.list()).toStrictEqual(expected);
    });

    it("takes a write through a transaction's view as it stands when commit is called", async ({
      skip,
    }) => {
      const target = await store();
      const transaction = transactionOf(target, skip);
      const { expected, scramble, write } = await callerWrite(target);

      await transaction(async (view) => {
        const committed = view.commit(write);
        scramble();
        await committed;
        expect(await view.list()).toStrictEqual(expected);
      });

      expect(await target.list()).toStrictEqual(expected);
    });

    it("hands out frozen rows, detached from the rows it keeps", async () => {
      const target = await store();
      await target.commit({ putContainers: [row("c1")] });
      const read = await target.get("c1");
      const listed = await target.list();
      expect(Object.isFrozen(read)).toBe(true);
      expect(Object.isFrozen(listed)).toBe(true);
      expect(Object.isFrozen(listed[0])).toBe(true);
      expect(read).not.toBe(listed[0]);
      expect(await target.list()).not.toBe(listed);
    });

    it("keeps two scopes on one storage apart", async () => {
      const stores = await open();
      const [first, second] = [stores("scope-a"), stores("scope-b")];
      await first.commit({ putContainers: [row("c1")] });
      expect(await second.get("c1")).toBeUndefined();
      expect(await second.list()).toEqual([]);

      await second.commit({
        putContainers: [row("c1", { status: "running" }), row("c2")],
      });
      await second.commit({ deleteContainers: ["c1"] });
      expect(await first.get("c1")).toStrictEqual(row("c1"));
      expect(ids(await first.list())).toEqual(["c1"]);
      expect(ids(await second.list())).toEqual(["c2"]);
      // The same scope reaches the same rows again.
      expect(await stores("scope-a").get("c1")).toStrictEqual(row("c1"));
    });

    it("keeps each transaction's reads and commit together", async ({
      skip,
    }) => {
      const target = await store();
      const transaction = transactionOf(target, skip);
      await target.commit({ putContainers: [row("c1")] });
      const bump = () =>
        transaction(async (view) => {
          const current = await view.get("c1");
          await yieldTurn();
          await view.commit({
            putContainers: [
              row("c1", { updatedAt: (current?.updatedAt ?? 0) + 1 }),
            ],
          });
        });
      await Promise.all([bump(), bump()]);
      expect((await target.get("c1"))?.updatedAt).toBe(3);
    });

    it("lands a plain commit only after a transaction it overlaps", async ({
      skip,
    }) => {
      const target = await store();
      const transaction = transactionOf(target, skip);
      await target.commit({ putContainers: [row("c1")] });
      const read = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const running = transaction(async (view) => {
        const before = await view.get("c1");
        read.resolve();
        await proceed.promise;
        const after = await view.get("c1");
        await view.commit({
          putContainers: [row("c1", { status: "stopped", updatedAt: 2 })],
        });
        return [before?.status, after?.status];
      });
      await read.promise;
      // An independent caller, while the transaction sits between its read
      // and its commit, given time enough to land if nothing held it back.
      const outside = target.commit({
        putContainers: [row("c1", { status: "running", updatedAt: 3 })],
      });
      await pause(20);
      proceed.resolve();

      expect(await running).toEqual(["starting", "starting"]);
      await outside;
      expect((await target.get("c1"))?.status).toBe("running");
    });

    it("reads its own commits and returns what its work returns", async ({
      skip,
    }) => {
      const target = await store();
      const transaction = transactionOf(target, skip);
      const result = await transaction(async (view) => {
        await view.commit({ putContainers: [row("c1")] });
        expect(await view.get("c1")).toStrictEqual(row("c1"));
        return ids(await view.list());
      });
      expect(result).toEqual(["c1"]);
      expect(await target.get("c1")).toStrictEqual(row("c1"));
    });

    it("keeps none of the commits of a transaction that throws, and runs the next", async ({
      skip,
    }) => {
      const target = await store();
      const transaction = transactionOf(target, skip);
      await target.commit({ putContainers: [row("kept")] });
      await expect(
        transaction(async (view) => {
          await view.commit({
            deleteContainers: ["kept"],
            putContainers: [row("c1")],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      expect(ids(await target.list())).toEqual(["kept"]);

      await transaction((view) => view.commit({ putContainers: [row("c1")] }));
      expect(ids(await target.list())).toEqual(["kept", "c1"]);
    });

    it("refuses a call to the store from inside its own transaction, at once", async ({
      skip,
    }) => {
      const target = await store();
      const transaction = transactionOf(target, skip);
      const calls: Record<string, () => Promise<unknown>> = {
        commit: () => target.commit({ putContainers: [row("a")] }),
        get: () => target.get("a"),
        list: () => target.list(),
        transaction: () => transaction(() => Promise.resolve()),
      };
      const { promise: ended, resolve: end } = Promise.withResolvers<void>();
      let later: Promise<unknown> = Promise.resolve();

      const refusals = await transaction(async (view) => {
        const outcomes: Record<string, string> = {};
        for (const [method, call] of Object.entries(calls)) {
          outcomes[method] = await settlesWithin(call(), 1000);
        }
        // Scheduled from inside, but run once the transaction has ended.
        later = ended.then(() => target.commit({ putContainers: [row("a")] }));
        await view.commit({ putContainers: [row("b")] });
        return outcomes;
      });
      end();

      expect(Object.keys(refusals)).toHaveLength(4);
      for (const outcome of Object.values(refusals)) {
        expect(outcome).toMatch(REFUSAL);
      }
      await later;
      expect(ids(await target.list())).toEqual(["b", "a"]);
    });
  });
}

/** The suite's proof that a store hands its host hook every commit's events. */
function describeRecordedEvents(
  name: string,
  recording: () => Promise<RecordingContainerStores>
): void {
  const recorder = async () => {
    const opened = await recording();
    return { ...opened, store: opened.stores("scope-a") };
  };

  describe(`${name} container store events handed to the host`, () => {
    it("hands on each commit's events once, in order, and none for a write without", async () => {
      const { recorded, store } = await recorder();
      const first = [
        event("sandbox.created", "c1"),
        event("sandbox.created", "c2"),
      ];
      await store.commit({
        events: first,
        putContainers: [row("c1"), row("c2")],
      });
      await store.commit({ putContainers: [row("c1", { status: "running" })] });
      await store.commit({
        deleteContainers: ["c2"],
        events: [event("sandbox.destroyed", "c2")],
      });

      expect(await recorded()).toEqual([
        ...first,
        event("sandbox.destroyed", "c2"),
      ]);
    });

    it("hands on the events as they were when commit was called", async () => {
      const { recorded, store } = await recorder();
      const given = { ...event("sandbox.created", "c1") };

      const pending = store.commit({
        events: [given],
        putContainers: [row("c1")],
      });
      (given as { containerId: string }).containerId = "changed later";
      await pending;

      expect(await recorded()).toEqual([event("sandbox.created", "c1")]);
    });

    it("refuses whole a write whose events cannot be copied", async () => {
      const { recorded, store } = await recorder();
      const unplain = {
        ...event("sandbox.created", "c1"),
        at: () => AT,
      } as unknown as SandboxEvent;

      await expect(
        store.commit({ events: [unplain], putContainers: [row("c1")] })
      ).rejects.toThrow();
      expect(await store.list()).toEqual([]);
      expect(await recorded()).toEqual([]);
    });

    it("records nothing for a write it refuses", async () => {
      const { recorded, store } = await recorder();
      const uncopyable = row("c1");
      Object.defineProperty(uncopyable, "spec", {
        enumerable: true,
        get: () => {
          throw new Error("uncopyable");
        },
      });

      await expect(
        store.commit({
          events: [event("sandbox.created", "c1")],
          putContainers: [uncopyable],
        })
      ).rejects.toThrow("uncopyable");
      expect(await recorded()).toEqual([]);
    });

    it("runs the hook inside the commit: a throw from it keeps neither the write nor its events", async () => {
      const { failNextCommit, recorded, store } = await recorder();
      failNextCommit();

      await expect(
        store.commit({
          events: [event("sandbox.created", "c1")],
          putContainers: [row("c1")],
        })
      ).rejects.toThrow();
      expect(await store.list()).toEqual([]);
      expect(await recorded()).toEqual([]);

      await store.commit({
        events: [event("sandbox.created", "c1")],
        putContainers: [row("c1")],
      });
      expect(await recorded()).toEqual([event("sandbox.created", "c1")]);
    });

    it("records a transaction's events only when it is kept", async () => {
      const { recorded, store } = await recorder();
      const { transaction } = store;
      if (transaction === undefined) {
        return;
      }

      await expect(
        transaction.call(store, async (view) => {
          await view.commit({
            events: [event("sandbox.created", "dropped")],
            putContainers: [row("dropped")],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      await transaction.call(store, async (view) => {
        await view.commit({
          events: [event("sandbox.created", "c1")],
          putContainers: [row("c1")],
        });
        await view.commit({
          events: [event("sandbox.failed", "c1")],
          putContainers: [row("c1", { status: "failed" })],
        });
      });

      expect(await recorded()).toEqual([
        event("sandbox.created", "c1"),
        event("sandbox.failed", "c1"),
      ]);
    });
  });
}
