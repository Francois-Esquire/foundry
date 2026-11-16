import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MIGRATIONS } from "~/database/migrate";
import type { StoreDatabase } from "~/database/open";
import { initializeDatabase, readDatabase } from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import { recordSpawned } from "~/process/spawned";

/**
 * The race `readDatabase` narrows but cannot close: the last writer closes
 * between the reader's connection opening and its first read. The reader's
 * first schema query is held until the writer, another process, has closed
 * and taken the side files with it, which `holder` makes happen on every
 * run.
 */
const race = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("~/database/migrate", async (original) => {
  const actual = await original<typeof import("~/database/migrate")>();
  return {
    ...actual,
    schemaState: async (...args: Parameters<typeof actual.schemaState>) => {
      const { before } = race;
      race.before = undefined;
      await before?.();
      return actual.schemaState(...args);
    },
  };
});

const SRC = resolve("src");
const children: ChildProcess[] = [];

afterEach(() => {
  race.before = undefined;
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
});

const ids = (database: StoreDatabase) =>
  database
    .select({ id: marblesWorkspaces.id })
    .from(marblesWorkspaces)
    .then((rows) => rows.map(({ id }) => id).sort());

/**
 * A process holding `file` open, with `id` recorded, until told to close.
 * Marbles makes and fills the file in a process of its own, which exits;
 * the holder then opens it with `bun:sqlite`, as its only connection.
 * Its close is SQLite's own, done when `close` returns: as the last
 * connection it checkpoints and takes the side files with it, on every
 * platform. libSQL's would wait for its native connection to be collected,
 * which a process may exit before, leaving them in place.
 */
async function holder(dir: string, file: string, id: string) {
  const seed = join(dir, "seed.ts");
  writeFileSync(
    seed,
    `import { initializeDatabase } from ${JSON.stringify(join(SRC, "database/open.ts"))};
import { marblesWorkspaces } from ${JSON.stringify(join(SRC, "database/tables.ts"))};
const opened = await initializeDatabase(${JSON.stringify(file)});
await opened.database.insert(marblesWorkspaces).values({ firstSeen: "x", id: ${JSON.stringify(id)}, lastSeen: "x", root: "/r" });
opened.close();
process.exit(0);
`
  );
  await new Promise<void>((done, failed) => {
    const seeding = spawn("bun", [seed], {
      cwd: resolve("."),
      stdio: "inherit",
    });
    recordSpawned(seeding.pid, false);
    children.push(seeding);
    seeding.once("exit", (code) =>
      code === 0 ? done() : failed(new Error(`the seed exited ${String(code)}`))
    );
  });
  const script = join(dir, "holder.ts");
  writeFileSync(
    script,
    `import { constants, Database } from "bun:sqlite";
const held = new Database(${JSON.stringify(file)});
// The last close takes the side files on every platform: some SQLite
// builds (Apple's) keep the WAL file by default.
held.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
// A read, so the side files are there and in use.
held.query("select count(*) from marbles_workspaces").get();
process.stdout.write("ready\\n");
process.stdin.once("data", () => {
  held.close();
  process.exit(0);
});
`
  );
  const child = spawn("bun", [script], {
    cwd: resolve("."),
    stdio: ["pipe", "pipe", "pipe"],
  });
  recordSpawned(child.pid, false);
  children.push(child);
  await new Promise<void>((ready, failed) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) {
        ready();
      }
    });
    child.once("exit", (code) =>
      failed(new Error(`the holder exited ${String(code)}`))
    );
  });
  return {
    async close() {
      const exited = new Promise((settle) => child.once("exit", settle));
      child.stdin?.write("close\n");
      await exited;
    },
  };
}

it("survives the last writer closing between its open and its first read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-race-"));
  const file = join(dir, "marbles.db");
  const writer = await holder(dir, file, "a");
  expect(existsSync(`${file}-wal`) && existsSync(`${file}-shm`)).toBe(true);
  let raced = false;
  race.before = async () => {
    await writer.close();
    raced = !(existsSync(`${file}-wal`) || existsSync(`${file}-shm`));
  };

  // The reader returns what was committed.
  expect(await readDatabase(file, ids)).toEqual(["a"]);
  // The writer went, and took the side files, between the reader's open
  // and its first read.
  expect(raced).toBe(true);
  // What the race may leave is an empty WAL file and the shared-memory
  // index of it, which no process has open, and nothing else.
  expect(statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);

  // The next reader reads past it.
  expect(await readDatabase(file, ids)).toEqual(["a"]);

  // The next Marbles process opens it and migrates it as usual, losing nothing.
  const next = join(dir, "migrations-next");
  cpSync(MIGRATIONS, next, { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(next, "meta", "_journal.json"), "utf8")
  ) as { entries: { tag: string; when: number }[] };
  const last = journal.entries.at(-1);
  if (last === undefined) {
    throw new Error("no migrations are committed");
  }
  journal.entries.push({ ...last, tag: "9999_probe", when: last.when + 1 });
  writeFileSync(join(next, "meta", "_journal.json"), JSON.stringify(journal));
  writeFileSync(
    join(next, "9999_probe.sql"),
    "CREATE TABLE `marbles_probe` (`id` text PRIMARY KEY NOT NULL);"
  );
  const opened = await initializeDatabase(file, { migrations: next });
  try {
    await opened.database.insert(marblesWorkspaces).values({
      firstSeen: "x",
      id: "b",
      lastSeen: "x",
      root: "/r",
    });
    expect(await ids(opened.database)).toEqual(["a", "b"]);
  } finally {
    opened.close();
  }
  expect(await readDatabase(file, ids, { migrations: next })).toEqual([
    "a",
    "b",
  ]);
}, 60_000);
