import type { ProcessIdentity } from "@foundry/lib/node/process-identity";
import { anotherStart } from "@foundry/lib/testing/process-identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoreDatabase } from "~/database/open";
import { marblesDeliveryClaims } from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

const watch = vi.hoisted(() => ({ asked: [] as boolean[], open: false }));

vi.mock("@foundry/lib/node/process-identity", async (actual) => {
  const real =
    await actual<typeof import("@foundry/lib/node/process-identity")>();
  return {
    ...real,
    isGone: (owner: ProcessIdentity) => {
      watch.asked.push(watch.open);
      return real.isGone(owner);
    },
  };
});

const machines: TestMachine[] = [];

afterEach(() => {
  watch.asked.length = 0;
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

async function watched() {
  const machine = await testMachine();
  machines.push(machine);
  const raw = machine.database.database;
  const next: { before?: () => Promise<void> } = {};
  const database = new Proxy(raw, {
    get(target, name) {
      if (name === "transaction") {
        return async (
          work: (transaction: unknown) => Promise<unknown>,
          ...rest: unknown[]
        ) => {
          const { before } = next;
          next.before = undefined;
          await before?.();
          return await (
            target.transaction as (...args: unknown[]) => Promise<unknown>
          )(
            async (transaction: unknown) => {
              watch.open = true;
              try {
                return await work(transaction);
              } finally {
                watch.open = false;
              }
            },
            ...rest
          );
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StoreDatabase;
  return { database, next, raw };
}

const gone = (): ProcessIdentity => ({
  pid: process.pid,
  started: anotherStart(),
});

describe("a claim on a row another engine left", () => {
  it("on delivering task changes judges its owner before its transaction", async () => {
    const { database, raw } = await watched();
    const left = gone();
    await raw.insert(marblesDeliveryClaims).values({
      ownerId: "gone-engine",
      ownerPid: left.pid,
      ownerStarted: left.started,
      scope: "ws",
    });
    const records = new DatabaseWorkspaceRecords({ database, scope: "ws" });
    expect(await records.claimDelivery()).toBeUndefined();
    expect(watch.asked).toEqual([false]);
    await records.releaseDelivery();
  });
});
