/**
 * The behaviour every {@link ContainerStore} shares. A store package runs it
 * against each store it ships; `open` hands back a fresh, empty store each
 * time, and two stores it returns must never see each other's rows.
 */
import { describe, expect, it } from "vitest";

import type { ContainerRow } from "../schema";
import type { ContainerStore } from "../store/index";

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
  return rows.map((item) => item.id).sort();
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

/** Lets every other queued callback run, so a missing exclusion would show. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function describeContainerStore(
  name: string,
  open: () => ContainerStore | Promise<ContainerStore>
): void {
  describe(`${name} container store conformance`, () => {
    it("starts empty", async () => {
      const store = await open();
      expect(await store.list()).toEqual([]);
      expect(await store.get("c1")).toBeUndefined();
    });

    it("reads back every field of a row it keeps", async () => {
      const store = await open();
      const before = row("c1");
      const after = row("c2", {
        createdAt: 1_700_000_000_000,
        nativeId: "c2-1",
        spec: '{"format":"foundry.sandbox.container/1"}',
        status: "running",
        updatedAt: 1_700_000_000_001,
      });
      await store.commit({ putContainers: [before, after] });
      expect(await store.get("c1")).toEqual(before);
      expect(await store.get("c2")).toEqual(after);
      expect(ids(await store.list())).toEqual(["c1", "c2"]);
    });

    it("replaces a row put under an id it already holds", async () => {
      const store = await open();
      await store.commit({ putContainers: [row("c1")] });
      const next = row("c1", {
        nativeId: "c1-1",
        status: "stopped",
        updatedAt: 2,
      });
      await store.commit({ putContainers: [next] });
      expect(await store.get("c1")).toEqual(next);
      expect(await store.list()).toEqual([next]);
    });

    it("deletes rows and ignores ids it does not hold", async () => {
      const store = await open();
      await store.commit({ putContainers: [row("c1"), row("c2")] });
      await store.commit({ deleteContainers: ["c1", "missing"] });
      expect(await store.get("c1")).toBeUndefined();
      expect(ids(await store.list())).toEqual(["c2"]);
    });

    it("applies deletes before puts in one write", async () => {
      const store = await open();
      await store.commit({ putContainers: [row("c1")] });
      const next = row("c1", { status: "running", updatedAt: 2 });
      await store.commit({
        deleteContainers: ["c1"],
        putContainers: [next],
      });
      expect(await store.get("c1")).toEqual(next);
    });

    it("accepts an empty write", async () => {
      const store = await open();
      await store.commit({ putContainers: [row("c1")] });
      await store.commit({});
      expect(ids(await store.list())).toEqual(["c1"]);
    });

    it("keeps nothing from a write that fails", async () => {
      const store = await open();
      await store.commit({ putContainers: [row("kept")] });
      // Every store reads each field of a row it keeps, so a `spec` that
      // throws on read fails a write that also carries a delete and a valid
      // put. The SQLite run will also force `onCommit` to throw after its
      // statements have executed.
      const unreadable = row("bad");
      Object.defineProperty(unreadable, "spec", {
        enumerable: true,
        get(): string {
          throw new Error("spec cannot be read");
        },
      });
      await expect(
        store.commit({
          deleteContainers: ["kept"],
          putContainers: [row("c1"), unreadable],
        })
      ).rejects.toThrow();
      expect(ids(await store.list())).toEqual(["kept"]);
      expect(await store.get("c1")).toBeUndefined();
    });

    it("detaches the rows it is given from the rows it keeps", async () => {
      const store = await open();
      const input = { ...row("c1") };
      await store.commit({ putContainers: [input] });
      input.status = "failed";
      expect((await store.get("c1"))?.status).toBe("starting");
    });

    it("detaches the rows it reads out from the rows it keeps", async () => {
      const store = await open();
      await store.commit({ putContainers: [row("c1")] });
      const read = await store.get("c1");
      const [listed] = await store.list();
      // Reflect.set rather than assignment: a store may hand out frozen rows.
      Reflect.set(read ?? {}, "status", "failed");
      Reflect.set(listed ?? {}, "status", "failed");
      expect(read).not.toBe(listed);
      expect((await store.get("c1"))?.status).toBe("starting");
      expect((await store.list())[0]?.status).toBe("starting");
    });

    it("keeps each transaction's reads and commit together", async ({
      skip,
    }) => {
      const store = await open();
      const transaction = transactionOf(store, skip);
      await store.commit({ putContainers: [row("c1")] });
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
      expect((await store.get("c1"))?.updatedAt).toBe(3);
    });

    it("lands a plain commit only after a transaction it overlaps", async ({
      skip,
    }) => {
      const store = await open();
      const transaction = transactionOf(store, skip);
      await store.commit({ putContainers: [row("c1")] });
      let outside: Promise<void> = Promise.resolve();
      const seen = await transaction(async (view) => {
        outside = store.commit({
          putContainers: [row("c1", { status: "running", updatedAt: 3 })],
        });
        await yieldTurn();
        const read = await view.get("c1");
        await view.commit({
          putContainers: [row("c1", { status: "stopped", updatedAt: 2 })],
        });
        return read?.status;
      });
      await outside;
      expect(seen).toBe("starting");
      expect((await store.get("c1"))?.status).toBe("running");
    });

    it("reads its own commits and returns what its work returns", async ({
      skip,
    }) => {
      const store = await open();
      const transaction = transactionOf(store, skip);
      const result = await transaction(async (view) => {
        await view.commit({ putContainers: [row("c1")] });
        return ids(await view.list());
      });
      expect(result).toEqual(["c1"]);
      expect(await store.get("c1")).toEqual(row("c1"));
    });

    it("keeps none of the commits of a transaction that throws", async ({
      skip,
    }) => {
      const store = await open();
      const transaction = transactionOf(store, skip);
      await store.commit({ putContainers: [row("kept")] });
      await expect(
        transaction(async (view) => {
          await view.commit({
            deleteContainers: ["kept"],
            putContainers: [row("c1")],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      expect(ids(await store.list())).toEqual(["kept"]);
    });

    it("keeps two stores apart", async () => {
      const first = await open();
      const second = await open();
      await first.commit({ putContainers: [row("c1")] });
      await second.commit({
        putContainers: [row("c1", { status: "running" }), row("c2")],
      });
      await second.commit({ deleteContainers: ["c1"] });
      expect(await first.get("c1")).toEqual(row("c1"));
      expect(ids(await first.list())).toEqual(["c1"]);
      expect(ids(await second.list())).toEqual(["c2"]);
    });
  });
}
