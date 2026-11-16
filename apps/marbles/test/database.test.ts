import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { Client } from "@libsql/client";
import { createClient } from "@libsql/client";
import { count, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { fileIdentity, queuedFiles, serialClient } from "~/database/client";
import { MIGRATIONS } from "~/database/migrate";
import type { StoreDatabase } from "~/database/open";
import {
  initializeDatabase,
  readDatabase,
  writeDatabase,
} from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import { transaction } from "~/database/transaction";
import { recordSpawned } from "~/process/spawned";

const SRC = resolve("src");
const NEWER = /migrated by a newer Marbles/;
const WAITING_ON_ITSELF = /waiting on itself/;
const DIFFERS_AT_FIRST =
  /differs from this Marbles at migration 1: .* ships 0000_init/;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "marbles-db-"));
}

function journalEntries(folder: string = MIGRATIONS): number {
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8")
  ) as { entries: unknown[] };
  return journal.entries.length;
}

async function pragma(database: StoreDatabase, name: string) {
  const [row] = await database.values(sql.raw(`PRAGMA ${name}`));
  return row?.[0];
}

async function applied(database: StoreDatabase): Promise<number> {
  const [row] = await database.values<[number]>(
    sql`SELECT count(*) FROM __drizzle_migrations`
  );
  return Number(row?.[0]);
}

function workspaceRow(id: string) {
  const now = new Date().toISOString();
  return { firstSeen: now, id, lastSeen: now, root: `/r/${id}` };
}

async function rows(database: StoreDatabase): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(marblesWorkspaces);
  return row?.total ?? 0;
}

describe("the Marbles database", () => {
  it("runs on Bun under the test runner", () => {
    expect(process.versions.bun).toBeDefined();
  });

  it("creates, configures and migrates a database in an empty directory", async () => {
    const file = join(scratch(), "nested", "marbles.db");
    const opened = await initializeDatabase(file);
    try {
      expect(existsSync(file)).toBe(true);
      expect(await pragma(opened.database, "journal_mode")).toBe("wal");
      expect(await pragma(opened.database, "foreign_keys")).toBe(1);
      expect(await pragma(opened.database, "busy_timeout")).toBe(5000);
      expect(await applied(opened.database)).toBe(journalEntries());
      expect(await rows(opened.database)).toBe(0);
    } finally {
      opened.close();
    }
  });

  it("reopens an existing database with its rows, and applies nothing twice", async () => {
    const file = join(scratch(), "marbles.db");
    const first = await initializeDatabase(file);
    await first.database.insert(marblesWorkspaces).values(workspaceRow("a"));
    first.close();

    const again = await initializeDatabase(file);
    try {
      expect(await rows(again.database)).toBe(1);
      expect(await applied(again.database)).toBe(journalEntries());
      expect(await pragma(again.database, "foreign_keys")).toBe(1);
    } finally {
      again.close();
    }
  });

  it("opens a migrated database while another connection is writing", async () => {
    const file = join(scratch(), "marbles.db");
    (await initializeDatabase(file)).close();
    const writer = createClient({ url: `file:${file}` });
    const held = await writer.transaction("write");
    try {
      await held.execute(
        "INSERT INTO marbles_workspaces (id, root, first_seen, last_seen) VALUES ('w', '/w', 'x', 'x')"
      );
      const reader = await initializeDatabase(file, { busyTimeout: 50 });
      try {
        expect(await rows(reader.database)).toBe(0);
      } finally {
        reader.close();
      }
    } finally {
      await held.rollback();
      writer.close();
    }
  });

  it("applies a migration added since the database was made", async () => {
    const dir = scratch();
    const folder = join(dir, "migrations");
    cpSync(MIGRATIONS, folder, { recursive: true });
    const file = join(dir, "marbles.db");
    (await initializeDatabase(file, { migrations: folder })).close();

    const journal = JSON.parse(
      readFileSync(join(folder, "meta", "_journal.json"), "utf8")
    ) as { entries: { tag: string; when: number }[] };
    const last = journal.entries.at(-1);
    if (last === undefined) {
      throw new Error("no migrations are committed");
    }
    journal.entries.push({
      ...last,
      tag: "9999_probe",
      when: last.when + 1,
    });
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify(journal)
    );
    writeFileSync(
      join(folder, "9999_probe.sql"),
      "CREATE TABLE `marbles_probe` (`id` text PRIMARY KEY NOT NULL);"
    );
    const migrated = await initializeDatabase(file, { migrations: folder });
    try {
      expect(await applied(migrated.database)).toBe(journalEntries() + 1);
      await migrated.database.run(sql`INSERT INTO marbles_probe VALUES ('x')`);
    } finally {
      migrated.close();
    }
    await expect(initializeDatabase(file)).rejects.toThrow(NEWER);
  });

  it("refuses a database whose applied history is not the one shipped", async () => {
    const dir = scratch();
    const file = join(dir, "marbles.db");
    (await initializeDatabase(file)).close();
    const edited = join(dir, "edited");
    cpSync(MIGRATIONS, edited, { recursive: true });
    const [first] = readdirSync(edited)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    if (first === undefined) {
      throw new Error("no migrations are committed");
    }
    appendFileSync(join(edited, first), "\n-- edited\n");
    await expect(
      initializeDatabase(file, { migrations: edited })
    ).rejects.toThrow(DIFFERS_AT_FIRST);
    const moved = join(dir, "moved");
    cpSync(MIGRATIONS, moved, { recursive: true });
    const journal = JSON.parse(
      readFileSync(join(moved, "meta", "_journal.json"), "utf8")
    ) as { entries: { when: number }[] };
    for (const entry of journal.entries) {
      entry.when += 1;
    }
    writeFileSync(
      join(moved, "meta", "_journal.json"),
      JSON.stringify(journal)
    );
    await expect(
      initializeDatabase(file, { migrations: moved })
    ).rejects.toThrow(DIFFERS_AT_FIRST);
  });

  it("gives every path to one database one queue", async () => {
    const dir = scratch();
    const real = join(dir, "real");
    mkdirSync(real);
    const linkedDir = join(dir, "linked");
    symlinkSync(real, linkedDir);
    const a = await initializeDatabase(join(linkedDir, "marbles.db"), {
      busyTimeout: 300,
    });
    const linkedFile = join(dir, "marbles.db");
    symlinkSync(join(real, "marbles.db"), linkedFile);
    const b = await initializeDatabase(join(real, "marbles.db"), {
      busyTimeout: 300,
    });
    const c = await initializeDatabase(linkedFile, { busyTimeout: 300 });
    try {
      const pause = () => new Promise((settle) => setTimeout(settle, 20));
      const write = (database: StoreDatabase, id: string) =>
        database.transaction(async (tx) => {
          await tx.insert(marblesWorkspaces).values(workspaceRow(`${id}-1`));
          await pause();
          await tx.insert(marblesWorkspaces).values(workspaceRow(`${id}-2`));
        });
      await Promise.all([
        write(a.database, "a"),
        write(b.database, "b"),
        write(c.database, "c"),
      ]);
      expect(await rows(a.database)).toBe(6);
      expect(queuedFiles()).toContain(fileIdentity(linkedFile));
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });

  it("gives every spelling of a database's name one queue where case does not count", async (context) => {
    const dir = scratch();
    writeFileSync(join(dir, "probe"), "");
    if (!existsSync(join(dir, "PROBE"))) {
      context.skip();
      return;
    }
    const lower = await initializeDatabase(join(dir, "marbles.db"), {
      busyTimeout: 300,
    });
    const upper = await initializeDatabase(join(dir, "MARBLES.DB"), {
      busyTimeout: 300,
    });
    const linked = join(dir, "linked.db");
    symlinkSync(join(dir, "Marbles.Db"), linked);
    const viaLink = await initializeDatabase(linked, { busyTimeout: 300 });
    try {
      const pause = () => new Promise((settle) => setTimeout(settle, 20));
      const write = (database: StoreDatabase, id: string) =>
        database.transaction(async (tx) => {
          await tx.insert(marblesWorkspaces).values(workspaceRow(`${id}-1`));
          await pause();
          await tx.insert(marblesWorkspaces).values(workspaceRow(`${id}-2`));
        });
      await Promise.all([
        write(lower.database, "lower"),
        write(upper.database, "upper"),
        write(viaLink.database, "link"),
      ]);
      expect(await rows(lower.database)).toBe(6);
    } finally {
      lower.close();
      upper.close();
      viaLink.close();
    }
  });

  it("keeps its locks while other handles in this process come and go", async () => {
    const dir = scratch();
    const file = join(dir, "marbles.db");
    const linked = join(dir, "linked.db");
    const holder = await initializeDatabase(file);
    try {
      await holder.database.insert(marblesWorkspaces).values(workspaceRow("a"));
      symlinkSync(file, linked);
      const wal = statSync(`${file}-wal`).ino;
      (await initializeDatabase(linked)).close();
      await readDatabase(linked, rows);
      await writeDatabase(file, rows);
      const other = join(dir, "other.ts");
      writeFileSync(
        other,
        `import { writeDatabase } from ${JSON.stringify(join(SRC, "database/open.ts"))};
import { marblesWorkspaces } from ${JSON.stringify(join(SRC, "database/tables.ts"))};
await writeDatabase(${JSON.stringify(file)}, (db) => db.insert(marblesWorkspaces).values({ firstSeen: "x", id: "b", lastSeen: "x", root: "/r" }));
Bun.gc(true);
`
      );
      const left = spawnSync("bun", [other], { encoding: "utf8" });
      expect(left.status, left.stderr).toBe(0);
      expect(statSync(`${file}-wal`).ino).toBe(wal);
      await holder.database.insert(marblesWorkspaces).values(workspaceRow("c"));
      expect(await readDatabase(file, rows)).toBe(3);
    } finally {
      holder.close();
    }
  });

  it("closes a client whose file it cannot identify, and keeps no queue for it", () => {
    const missing = join(scratch(), "gone", "marbles.db");
    let closed = 0;
    const client = {
      close() {
        closed += 1;
      },
    } as unknown as Client;
    const before = queuedFiles().length;
    expect(() => serialClient(client, missing, 1000)).toThrow();
    expect(closed).toBe(1);
    expect(queuedFiles()).toHaveLength(before);
  });

  it("keeps a file's queue only while a handle is open or a turn is pending", async () => {
    const file = join(scratch(), "marbles.db");
    const a = await initializeDatabase(file);
    const identity = fileIdentity(file);
    const queued = () => queuedFiles().filter((key) => key === identity);
    const b = await initializeDatabase(file);
    expect(queued()).toHaveLength(1);
    a.close();
    a.close();
    expect(queued()).toHaveLength(1);
    const gate = Promise.withResolvers<void>();
    const held = b.database.transaction(() => gate.promise);
    await new Promise((settle) => setTimeout(settle, 20));
    b.close();
    expect(queued()).toHaveLength(1);
    gate.resolve();
    await held.catch(() => undefined);
    expect(queued()).toEqual([]);
    const newer = join(scratch(), "marbles.db");
    const folder = join(scratch(), "migrations");
    cpSync(MIGRATIONS, folder, { recursive: true });
    (await initializeDatabase(newer, { migrations: folder })).close();
    writeFileSync(join(folder, "meta", "_journal.json"), '{"entries":[]}');
    await expect(
      initializeDatabase(newer, { migrations: folder })
    ).rejects.toThrow(NEWER);
    expect(queuedFiles()).not.toContain(fileIdentity(newer));
  });

  it("lets two handles in one process overlap their transactions", async () => {
    const file = join(scratch(), "marbles.db");
    const a = await initializeDatabase(file, { busyTimeout: 1000 });
    const b = await initializeDatabase(file, { busyTimeout: 1000 });
    try {
      const pause = () => new Promise((settle) => setTimeout(settle, 20));
      const write = (database: StoreDatabase, id: string) =>
        database.transaction(async (tx) => {
          await tx.insert(marblesWorkspaces).values(workspaceRow(`${id}-1`));
          await pause();
          await tx.insert(marblesWorkspaces).values(workspaceRow(`${id}-2`));
        });
      const failing = a.database.transaction(async (tx) => {
        await tx.insert(marblesWorkspaces).values(workspaceRow("gone"));
        await pause();
        throw new Error("rolled back");
      });
      await Promise.all([
        write(a.database, "a"),
        write(b.database, "b"),
        expect(failing).rejects.toThrow("rolled back"),
        write(b.database, "c"),
      ]);
      expect(await rows(a.database)).toBe(6);
    } finally {
      a.close();
      b.close();
    }
  });

  it("hands a package store a transaction to commit inside", async () => {
    class PackageStore {
      readonly #database: BaseSQLiteDatabase<"async", unknown>;
      constructor(options: {
        readonly database: BaseSQLiteDatabase<"async", unknown>;
      }) {
        this.#database = options.database;
      }
      async commit(ids: readonly string[]): Promise<void> {
        await this.#database.transaction(async (tx) => {
          for (const id of ids) {
            await tx.insert(marblesWorkspaces).values(workspaceRow(id));
          }
        });
      }
    }
    const opened = await initializeDatabase(join(scratch(), "marbles.db"));
    try {
      await new PackageStore({ database: opened.database }).commit(["a"]);
      await expect(
        transaction(opened.database, async (tx) => {
          await new PackageStore({ database: tx }).commit(["b", "c"]);
          throw new Error("the host's own write failed");
        })
      ).rejects.toThrow("the host's own write failed");
      await transaction(opened.database, async (tx) => {
        await new PackageStore({ database: tx }).commit(["d"]);
        await tx.insert(marblesWorkspaces).values(workspaceRow("e"));
      });
      const ids = await opened.database
        .select({ id: marblesWorkspaces.id })
        .from(marblesWorkspaces);
      expect(ids.map(({ id }) => id).sort()).toEqual(["a", "d", "e"]);
    } finally {
      opened.close();
    }
  });

  it("refuses, rather than hangs, a transaction that waits on itself", async () => {
    const file = join(scratch(), "marbles.db");
    const opened = await initializeDatabase(file, { busyTimeout: 200 });
    try {
      await expect(
        opened.database.transaction(async () => {
          await rows(opened.database);
        })
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringMatching(WAITING_ON_ITSELF),
        }),
      });
      expect(await rows(opened.database)).toBe(0);
    } finally {
      opened.close();
    }
  });

  it("is opened, migrated and written by several processes at once", async () => {
    const dir = scratch();
    const file = join(dir, "marbles.db");
    const go = join(dir, "go");
    const writers = 3;
    const transactions = 15;
    const script = join(dir, "writer.ts");
    writeFileSync(
      script,
      `import { existsSync } from "node:fs";
import { initializeDatabase } from ${JSON.stringify(join(SRC, "database/open.ts"))};
import { marblesWorkspaces } from ${JSON.stringify(join(SRC, "database/tables.ts"))};
const [name] = process.argv.slice(2);
process.stdout.write("ready\\n");
while (!existsSync(${JSON.stringify(go)})) {
  await new Promise((settle) => setTimeout(settle, 5));
}
const opened = await initializeDatabase(${JSON.stringify(file)});
const now = new Date().toISOString();
const row = (id) => ({ firstSeen: now, id, lastSeen: now, root: "/r" });
for (let i = 0; i < ${String(transactions)}; i += 1) {
  await opened.database.transaction(async (tx) => {
    await tx.insert(marblesWorkspaces).values(row(name + "-" + i + "-a"));
    await new Promise((settle) => setTimeout(settle, 1));
    await tx.insert(marblesWorkspaces).values(row(name + "-" + i + "-b"));
  });
}
opened.close();
`
    );
    const children = Array.from({ length: writers }, (_, index) =>
      spawn("bun", [script, `w${String(index)}`], {
        cwd: resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
      })
    );
    for (const child of children) {
      recordSpawned(child.pid, false);
    }
    const exits = children.map(
      (child) =>
        new Promise<{ code: number | null; stderr: string }>((settle) => {
          let stderr = "";
          child.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.once("exit", (code) => settle({ code, stderr }));
        })
    );
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((ready) => {
            child.stdout?.on("data", (chunk: Buffer) => {
              if (chunk.toString().includes("ready")) {
                ready();
              }
            });
          })
      )
    );
    writeFileSync(go, "");
    for (const exit of await Promise.all(exits)) {
      expect(exit.code, exit.stderr).toBe(0);
    }
    const opened = await initializeDatabase(file);
    try {
      expect(await rows(opened.database)).toBe(writers * transactions * 2);
      expect(await applied(opened.database)).toBe(journalEntries());
      expect(await pragma(opened.database, "journal_mode")).toBe("wal");
    } finally {
      opened.close();
    }
  }, 60_000);

  it("has a committed migration for everything in the schema", async () => {
    const out = join(scratch(), "migrations");
    cpSync(MIGRATIONS, out, { recursive: true });
    const before = readdirSync(out).sort();
    const generated = spawn(
      resolve("../../node_modules/.bin/drizzle-kit"),
      [
        "generate",
        "--dialect",
        "sqlite",
        "--schema",
        "./src/database/schema.ts",
        "--out",
        relative(resolve("."), out),
      ],
      {
        cwd: resolve("."),
        env: { ...process.env, NODE_OPTIONS: "--conditions=import" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    recordSpawned(generated.pid, false);
    let output = "";
    generated.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    generated.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const code = await new Promise((settle) => generated.once("exit", settle));
    expect(code, output).toBe(0);
    expect(output).toContain("No schema changes");
    expect(readdirSync(out).sort(), output).toEqual(before);
  }, 60_000);
});
