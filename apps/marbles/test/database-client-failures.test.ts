import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Client,
  InStatement,
  ResultSet,
  Transaction,
} from "@libsql/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { serialClient } from "~/database/client";
import { guardedClient } from "~/database/guard";
import { IncompatibleDatabaseError } from "~/database/migrate";
import { temporaryDirectory } from "./helpers/temporary";

function databaseFile(): string {
  const file = join(temporaryDirectory("marbles-client-failures-"), "fake.db");
  writeFileSync(file, "");
  return file;
}

function rows(...values: unknown[][]): ResultSet {
  return { rows: values } as unknown as ResultSet;
}

interface FakeTransaction {
  readonly execute?: (stmt: InStatement) => Promise<ResultSet>;
  readonly rollback?: () => Promise<void>;
}

function fakeTransaction(fake: FakeTransaction = {}): Transaction {
  let closed = false;
  return {
    batch: () => Promise.resolve([]),
    close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
    commit: () => {
      closed = true;
      return Promise.resolve();
    },
    execute: fake.execute ?? (() => Promise.resolve(rows())),
    executeMultiple: () => Promise.resolve(),
    rollback: async () => {
      await fake.rollback?.();
      closed = true;
    },
  } as unknown as Transaction;
}

function fakeClient(
  executed: string[],
  transaction: () => Transaction = () => fakeTransaction()
): Client {
  return {
    close: () => undefined,
    closed: false,
    execute: (stmt: InStatement | string) => {
      executed.push(typeof stmt === "string" ? stmt : stmt.sql);
      return Promise.resolve(rows());
    },
    reconnect: () => {
      executed.push("reconnect");
      return Promise.resolve();
    },
    transaction: () => Promise.resolve(transaction()),
  } as unknown as Client;
}

function busy(): Error {
  return Object.assign(new Error("database is locked"), {
    code: "SQLITE_BUSY",
  });
}

function unhandledRejections(): unknown[] {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  onTestFinished(() => {
    process.off("unhandledRejection", listener);
  });
  return seen;
}

const settled = () => new Promise((done) => setTimeout(done, 50));

describe("a serial client", () => {
  it("lets a closed transaction go when reconnecting after its busy failure fails", async () => {
    const seen = unhandledRejections();
    const failing = fakeTransaction({ execute: () => Promise.reject(busy()) });
    const client = serialClient(
      fakeClient([], () => failing),
      databaseFile(),
      1000,
      {
        connect: () => {
          throw new Error("the database cannot be opened again");
        },
      }
    );
    const transaction = await client.transaction("write");
    await expect(transaction.execute("SELECT 1")).rejects.toThrow(
      "database is locked"
    );
    transaction.close();
    await settled();
    expect(seen).toEqual([]);
    await expect(client.execute("SELECT 1")).resolves.toBeDefined();
    client.close();
  });

  it("reconnects in its turn, and applies its settings again afterwards", async () => {
    const executed: string[] = [];
    const client = serialClient(fakeClient(executed), databaseFile(), 1000, {
      settings: ["PRAGMA foreign_keys = ON"],
    });
    await client.execute("SELECT 1");
    const transaction = await client.transaction("write");
    let reconnected = false;
    const reconnecting = Promise.resolve(client.reconnect()).then(() => {
      reconnected = true;
    });
    await settled();
    expect(reconnected).toBe(false);
    await transaction.commit();
    await reconnecting;
    await client.execute("SELECT 2");
    expect(executed).toEqual([
      "PRAGMA foreign_keys = ON",
      "SELECT 1",
      "reconnect",
      "PRAGMA foreign_keys = ON",
      "SELECT 2",
    ]);
    client.close();
  });
});

describe("a guarded client whose rollback fails", () => {
  const rollback = () => Promise.reject(new Error("the rollback failed"));

  it("throws the incompatible database it found, not the rollback's failure", async () => {
    const client = guardedClient(
      fakeClient([], () =>
        fakeTransaction({
          execute: () => Promise.resolve(rows([5, 1])),
          rollback,
        })
      ),
      databaseFile(),
      []
    );
    await expect(client.transaction("write")).rejects.toThrow(
      IncompatibleDatabaseError
    );
  });

  it("throws the work's own failure, not the rollback's", async () => {
    let calls = 0;
    const client = guardedClient(
      fakeClient([], () =>
        fakeTransaction({
          execute: () => {
            calls += 1;
            return calls === 1
              ? Promise.resolve(rows([0, null]))
              : Promise.reject(new Error("the work failed"));
          },
          rollback,
        })
      ),
      databaseFile(),
      []
    );
    await expect(
      client.execute("INSERT INTO probe VALUES (1)")
    ).rejects.toThrow("the work failed");
  });
});
