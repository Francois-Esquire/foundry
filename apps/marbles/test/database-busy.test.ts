import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { serialClient } from "~/database/client";
import { initializeDatabase, openDatabase } from "~/database/open";

const BUSY = /SQLITE_BUSY/;
const FOREIGN_KEY = /FOREIGN KEY constraint failed/;
const CLIENT = resolve("../../node_modules/@libsql/client/lib-esm/node.js");

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "marbles-busy-"));
  roots.push(root);
  return root;
}

function causedBy(pattern: RegExp): (error: unknown) => boolean {
  return (error) => {
    for (let cause = error; cause instanceof Error; cause = cause.cause) {
      if (pattern.test(cause.message)) {
        return true;
      }
    }
    return false;
  };
}

interface Holder {
  release(): Promise<void>;
}

async function holdLock(file: string, kind: "read" | "write"): Promise<Holder> {
  const release = `${file}.release-${kind}`;
  const script = `import { createClient } from ${JSON.stringify(CLIENT)};
import { existsSync } from "node:fs";
const client = createClient({ url: ${JSON.stringify(pathToFileURL(file).href)} });
const held = await client.transaction(${JSON.stringify(kind === "write" ? "write" : "deferred")});
await held.execute(${JSON.stringify(kind === "write" ? "INSERT INTO parent VALUES (99)" : "SELECT count(*) FROM parent")});
process.stdout.write("held\\n");
while (!existsSync(${JSON.stringify(release)})) await new Promise((done) => setTimeout(done, 5));
// Used after the wait, so it is not collected, and rolled back, before.
await held.rollback();
client.close();
`;
  const child = spawn("bun", ["-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  await new Promise<void>((ready, failed) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("held")) {
        ready();
      }
    });
    child.once("exit", (code) => failed(new Error(`exited ${code}`)));
  });
  return {
    async release() {
      const exited = new Promise((done) => child.once("exit", done));
      writeFileSync(release, "");
      await exited;
    },
  };
}

const TABLES = [
  "CREATE TABLE parent (id integer PRIMARY KEY)",
  "CREATE TABLE child (parent_id integer REFERENCES parent(id))",
];

describe("a handle SQLite answered SQLITE_BUSY", () => {
  it("writes again once the lock is free when BEGIN was refused, and still enforces foreign keys", async () => {
    const file = join(scratch(), "marbles.db");
    const made = await initializeDatabase(file);
    for (const table of TABLES) {
      await made.database.run(table);
    }
    made.close();
    const host = await openDatabase(file, { busyTimeout: 50 });
    if (host === undefined) {
      throw new Error("the database was not made");
    }
    try {
      const holder = await holdLock(file, "write");
      await expect(
        host.database.transaction(async (tx) => {
          await tx.run("INSERT INTO parent VALUES (1)");
        })
      ).rejects.toSatisfy(causedBy(BUSY));
      await holder.release();

      for (const id of [1, 2]) {
        await host.database.transaction(async (tx) => {
          await tx.run(`INSERT INTO parent VALUES (${String(id)})`);
          await tx.run(`INSERT INTO child VALUES (${String(id)})`);
        });
      }
      await expect(
        host.database.run("INSERT INTO child VALUES (404)")
      ).rejects.toSatisfy(causedBy(FOREIGN_KEY));
      const ids = await host.database.all<{ id: number }>(
        "SELECT id FROM parent"
      );
      expect(ids.map((row) => row.id)).toEqual([1, 2]);
    } finally {
      host.close();
    }
  });

  it("writes again once the lock is free when COMMIT was refused, and still enforces foreign keys", async () => {
    const file = join(scratch(), "rollback.db");
    const url = pathToFileURL(file).href;
    const setup = createClient({ url });
    for (const table of TABLES) {
      await setup.execute(table);
    }
    setup.close();
    const connect = (): Client =>
      createClient({ concurrency: 1, timeout: 50, url });
    const host = serialClient(connect(), file, 5000, {
      connect,
      settings: ["PRAGMA foreign_keys = ON"],
    });
    try {
      const holder = await holdLock(file, "read");
      const refused = await host.transaction("write");
      await refused.execute("INSERT INTO parent VALUES (1)");
      await expect(refused.commit()).rejects.toSatisfy(causedBy(BUSY));
      await refused.rollback();
      await holder.release();

      for (const id of [1, 2]) {
        const tx = await host.transaction("write");
        await tx.execute(`INSERT INTO parent VALUES (${String(id)})`);
        await tx.commit();
      }
      await expect(
        host.execute("INSERT INTO child VALUES (404)")
      ).rejects.toSatisfy(causedBy(FOREIGN_KEY));
      const { rows } = await host.execute("SELECT id FROM parent");
      expect(rows.map((row) => Number(row[0]))).toEqual([1, 2]);
    } finally {
      host.close();
    }
  });

  it("keeps a lock a handle here holds while another client here on the file closes", async () => {
    const file = join(scratch(), "marbles.db");
    const made = await initializeDatabase(file);
    for (const table of TABLES) {
      await made.database.run(table);
    }
    made.close();
    const host = await openDatabase(file);
    if (host === undefined) {
      throw new Error("the database was not made");
    }
    const { $client: client } = host.database as unknown as {
      readonly $client: Client;
    };
    const writing = await client.transaction("write");
    try {
      await writing.execute("INSERT INTO parent VALUES (7)");
      const other = createClient({ url: pathToFileURL(file).href });
      await other.execute("SELECT count(*) FROM parent");
      other.close();
      const probe = spawn(
        "bun",
        [
          "-e",
          `import { createClient } from ${JSON.stringify(CLIENT)};
const client = createClient({ url: ${JSON.stringify(pathToFileURL(file).href)} });
try { const tx = await client.transaction("write"); await tx.rollback(); process.stdout.write("took it\\n"); }
catch (error) { process.stdout.write(String(error) + "\\n"); }`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      children.push(probe);
      let said = "";
      probe.stdout?.on("data", (chunk: Buffer) => {
        said += chunk.toString();
      });
      await new Promise((done) => probe.once("exit", done));
      expect(said).toMatch(BUSY);
      expect(existsSync(`${file}-shm`)).toBe(true);
    } finally {
      await writing.rollback();
      host.close();
    }
  });
});
