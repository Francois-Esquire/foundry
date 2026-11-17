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

async function holder(dir: string, file: string, id: string) {
  const script = join(dir, "holder.ts");
  writeFileSync(
    script,
    `import { initializeDatabase } from ${JSON.stringify(join(SRC, "database/open.ts"))};
import { marblesWorkspaces } from ${JSON.stringify(join(SRC, "database/tables.ts"))};
const opened = await initializeDatabase(${JSON.stringify(file)});
await opened.database.insert(marblesWorkspaces).values({ firstSeen: "x", id: ${JSON.stringify(id)}, lastSeen: "x", root: "/r" });
process.stdout.write("ready\\n");
process.stdin.once("data", async () => {
  opened.close();
  // libSQL lets the native connection, and the side files, go once it is collected.
  Bun.gc(true);
  await new Promise((settle) => setTimeout(settle, 50));
  Bun.gc(true);
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

  expect(await readDatabase(file, ids)).toEqual(["a"]);
  expect(raced).toBe(true);
  expect(existsSync(`${file}-shm`)).toBe(false);
  expect(statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);

  expect(await readDatabase(file, ids)).toEqual(["a"]);

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
