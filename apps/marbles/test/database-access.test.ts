import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { IncompatibleDatabaseError, MIGRATIONS } from "~/database/migrate";
import type { StoreDatabase } from "~/database/open";
import {
  initializeDatabase,
  readDatabase,
  writeDatabase,
} from "~/database/open";
import { marblesWorkspaces } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { workspaceState } from "~/lib/state/workspace";
import { recordSpawned } from "~/process/spawned";
import { cliArgs } from "./helpers/cli";
import { type TestHome, testHome } from "./helpers/home";
import { readWorkspace, touchWorkspace } from "./helpers/registry";

const SRC = resolve("src");
const OLDER = /is older than this Marbles: it lacks 9999_probe/;
const NEWER = /migrated by a newer Marbles/;
const READONLY = /readonly|read-only/i;
const UNCLEAN = /not closed cleanly/;
const STACK_FRAME = /^\s+at /m;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "marbles-access-"));
}

function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name)).toString("base64")])
  );
}

function dataFiles(dir: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot(dir)).filter(([name]) => !name.endsWith("-shm"))
  );
}

function row(id: string) {
  return { firstSeen: "x", id, lastSeen: "x", root: `/r/${id}` };
}

const ids = (database: StoreDatabase) =>
  database
    .select({ id: marblesWorkspaces.id })
    .from(marblesWorkspaces)
    .then((rows) => rows.map(({ id }) => id).sort());

function processWith(
  dir: string,
  file: string,
  id: string,
  then: "exit" | "hold" | "open",
  migrations: string = MIGRATIONS
): Promise<ChildProcess> {
  const script = join(dir, `${then}-${id}.ts`);
  writeFileSync(
    script,
    `import { initializeDatabase } from ${JSON.stringify(join(SRC, "database/open.ts"))};
import { marblesWorkspaces } from ${JSON.stringify(join(SRC, "database/tables.ts"))};
const opened = await initializeDatabase(${JSON.stringify(file)}, { migrations: ${JSON.stringify(migrations)} });
await opened.database.insert(marblesWorkspaces).values({ firstSeen: "x", id: ${JSON.stringify(id)}, lastSeen: "x", root: "/r" });
if (${JSON.stringify(then)} === "hold") {
  await opened.database.transaction(async (tx) => {
    await tx.insert(marblesWorkspaces).values({ firstSeen: "x", id: "uncommitted", lastSeen: "x", root: "/r" });
    process.stdout.write("ready\\n");
    await new Promise(() => undefined);
  });
} else if (${JSON.stringify(then)} === "open") {
  process.stdout.write("ready\\n");
  await new Promise(() => undefined);
} else {
  opened.close();
  // libSQL lets the native connection go, and with it the side files, only
  // once it is collected: collect until they are gone, for a while.
  const { existsSync } = await import("node:fs");
  for (let i = 0; i < 100 && existsSync(${JSON.stringify(file)} + "-shm"); i += 1) {
    Bun.gc(true);
    await new Promise((settle) => setTimeout(settle, 20));
  }
  process.stdout.write("ready\\n");
}
`
  );
  const child = spawn("bun", [script], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  recordSpawned(child.pid, false);
  children.push(child);
  return new Promise((ready, failed) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) {
        ready(child);
      }
    });
    child.once("exit", (code) => {
      if (then !== "exit" || code !== 0) {
        failed(new Error(`the writer exited ${String(code)}: ${stderr}`));
      }
    });
  });
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode === null) {
    await new Promise((settle) => child.once("exit", settle));
  }
}

function withProbeMigration(dir: string): string {
  const folder = join(dir, "migrations-next");
  cpSync(MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const last = journal.entries.at(-1);
  if (last === undefined) {
    throw new Error("no migrations are committed");
  }
  journal.entries.push({ ...last, tag: "9999_probe", when: last.when + 1 });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(
    join(folder, "9999_probe.sql"),
    "CREATE TABLE `marbles_probe` (`id` text PRIMARY KEY NOT NULL);"
  );
  return folder;
}

describe("reading the Marbles database", () => {
  it("creates nothing where there is no database", async () => {
    const dir = scratch();
    const file = join(dir, "state", "marbles.db");
    expect(await readDatabase(file, ids)).toBeUndefined();
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  it("reads one no process has open without leaving a side file", async () => {
    const dir = join(scratch(), "state");
    const file = join(dir, "marbles.db");
    const writer = await processWith(scratch(), file, "a", "exit");
    await exited(writer);
    expect(readdirSync(dir)).toEqual(["marbles.db"]);
    const before = snapshot(dir);
    expect(await readDatabase(file, ids)).toEqual(["a"]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("reads one another process holds open, seeing only what it committed", async () => {
    const dir = join(scratch(), "state");
    const file = join(dir, "marbles.db");
    await processWith(scratch(), file, "a", "hold");
    expect(existsSync(`${file}-wal`)).toBe(true);
    const before = snapshot(dir);
    expect(await readDatabase(file, ids, { busyTimeout: 100 })).toEqual(["a"]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("reads one whose process was killed holding it, leaving the main file as it was", async () => {
    const dir = join(scratch(), "state");
    const file = join(dir, "marbles.db");
    const holder = await processWith(scratch(), file, "a", "hold");
    holder.kill("SIGKILL");
    await exited(holder);
    expect(readdirSync(dir).sort()).toEqual([
      "marbles.db",
      "marbles.db-shm",
      "marbles.db-wal",
    ]);
    const main = readFileSync(file);
    const wal = readFileSync(`${file}-wal`);
    expect(await readDatabase(file, ids)).toEqual(["a"]);
    expect(readdirSync(dir).sort()).toEqual([
      "marbles.db",
      "marbles.db-shm",
      "marbles.db-wal",
    ]);
    expect(readFileSync(file).equals(main)).toBe(true);
    expect(readFileSync(`${file}-wal`).equals(wal)).toBe(true);
  });

  it("cannot write through the connection it reads with", async () => {
    const dir = join(scratch(), "state");
    const file = join(dir, "marbles.db");
    await exited(await processWith(scratch(), file, "a", "exit"));
    await expect(
      readDatabase(file, (database) =>
        database.insert(marblesWorkspaces).values(row("b"))
      )
    ).rejects.toThrow();
    await processWith(scratch(), file, "b", "hold");
    await expect(
      readDatabase(file, (database) =>
        database.insert(marblesWorkspaces).values(row("c"))
      )
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(READONLY),
      }),
    });
  });

  it("leaves this process free to write the database another process holds open", async () => {
    const dir = join(scratch(), "state");
    const file = join(dir, "marbles.db");
    await processWith(scratch(), file, "a", "open");
    const write = (id: string) =>
      writeDatabase(file, (database) =>
        database.insert(marblesWorkspaces).values(row(id))
      );
    await readDatabase(file, async (database) => {
      expect(await ids(database)).toEqual(["a"]);
      await write("b");
    });
    await write("c");
    expect(await readDatabase(file, ids)).toEqual(["a", "b", "c"]);
  });

  it("refuses a schema behind or ahead of this Marbles without touching the file", async () => {
    const work = scratch();
    const next = withProbeMigration(work);
    const older = join(scratch(), "marbles.db");
    await exited(await processWith(work, older, "a", "exit"));
    const olderBefore = dataFiles(join(older, ".."));
    await expect(
      readDatabase(older, ids, { migrations: next })
    ).rejects.toThrow(OLDER);
    await expect(
      readDatabase(older, ids, { migrations: next })
    ).rejects.toBeInstanceOf(IncompatibleDatabaseError);
    expect(dataFiles(join(older, ".."))).toEqual(olderBefore);

    const newer = join(scratch(), "marbles.db");
    await exited(await processWith(work, newer, "a", "exit", next));
    const newerBefore = dataFiles(join(newer, ".."));
    await expect(readDatabase(newer, ids)).rejects.toThrow(NEWER);
    expect(dataFiles(join(newer, ".."))).toEqual(newerBefore);
  });

  it("refuses a WAL file it would have to recover, creating nothing", async () => {
    const dir = join(scratch(), "state");
    const file = join(dir, "marbles.db");
    const holder = await processWith(scratch(), file, "a", "hold");
    holder.kill("SIGKILL");
    await exited(holder);
    rmSync(`${file}-shm`);
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const before = snapshot(dir);
    await expect(readDatabase(file, ids)).rejects.toThrow(UNCLEAN);
    expect(snapshot(dir)).toEqual(before);
  });

  it("reads past an empty WAL file, as the narrow race leaves one", async () => {
    const dir = join(scratch(), "state");
    const file = join(dir, "marbles.db");
    await exited(await processWith(scratch(), file, "a", "exit"));
    writeFileSync(`${file}-wal`, "");
    const before = snapshot(dir);
    expect(await readDatabase(file, ids)).toEqual(["a"]);
    expect(snapshot(dir)).toEqual(before);
  });

  it("finds nothing recorded in a file nothing was migrated into", async () => {
    const dir = join(scratch(), "state");
    const file = join(dir, "marbles.db");
    await exited(await processWith(scratch(), file, "a", "exit"));
    const empty = join(dir, "empty.db");
    writeFileSync(empty, "");
    expect(await readDatabase(empty, ids)).toBeUndefined();
  });
});

describe("writing to the Marbles database outside the Marbles process", () => {
  it("creates nothing where there is no database", async () => {
    const dir = scratch();
    const file = join(dir, "state", "marbles.db");
    let ran = false;
    expect(
      await writeDatabase(file, async () => {
        ran = true;
      })
    ).toBeUndefined();
    expect(ran).toBe(false);
    expect(existsSync(join(dir, "state"))).toBe(false);
  });

  it("writes to a current database, and never migrates one that is behind", async () => {
    const work = scratch();
    const next = withProbeMigration(work);
    const file = join(scratch(), "marbles.db");
    await exited(await processWith(work, file, "a", "exit"));
    await writeDatabase(file, async (database) => {
      await database.insert(marblesWorkspaces).values(row("b"));
    });
    await expect(
      writeDatabase(
        file,
        (database) => database.insert(marblesWorkspaces).values(row("c")),
        { migrations: next }
      )
    ).rejects.toThrow(OLDER);
    const opened = await initializeDatabase(file);
    try {
      expect(await ids(opened.database)).toEqual(["a", "b"]);
    } finally {
      opened.close();
    }
  });
});

describe("the CLI on the Marbles database", () => {
  function marbles(home: TestHome, cwd: string, ...args: string[]) {
    return spawnSync("bun", ["--no-env-file", ...cliArgs(...args)], {
      cwd,
      encoding: "utf8",
      env: home.env,
      timeout: 60_000,
    });
  }

  it("says in one line that a database is newer, and leaves it alone", async () => {
    const work = scratch();
    const home = testHome();
    const { state } = home.layout;
    await exited(
      await processWith(
        work,
        stateDatabase(state),
        "a",
        "exit",
        withProbeMigration(work)
      )
    );
    const before = snapshot(state);
    const status = marbles(home, work, "status");
    expect(status.status).toBe(1);
    expect(status.stderr).toMatch(NEWER);
    expect(status.stderr).not.toMatch(STACK_FRAME);
    expect(snapshot(state)).toEqual(before);
  }, 60_000);

  it("clears the record of a workspace whose state links out, without following the link", async () => {
    const root = scratch();
    const home = testHome();
    const { state } = home.layout;
    const workspace = workspaceState(state, root);
    await touchWorkspace(state, workspace, null, { hosted: true });
    const outside = scratch();
    symlinkSync(outside, workspace.dir);
    const detached = marbles(home, root, "daemon", "detach");
    expect(detached.status, detached.stderr).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
    const stored = async () => {
      const opened = await initializeDatabase(stateDatabase(state));
      try {
        const [record] = await opened.database
          .select({ hosted: marblesWorkspaces.hosted })
          .from(marblesWorkspaces)
          .where(eq(marblesWorkspaces.id, workspace.id));
        return record?.hosted;
      } finally {
        opened.close();
      }
    };
    expect(await stored()).toBe(false);
    rmSync(workspace.dir);
    expect((await readWorkspace(state, workspace.id))?.hosted).toBe(false);
  }, 60_000);

  it("clears a hosted record when it detaches with no Marbles process running", async () => {
    const root = scratch();
    const home = testHome();
    const { state } = home.layout;
    const workspace = workspaceState(state, root);
    await touchWorkspace(state, workspace, null, { hosted: true });
    const detached = marbles(home, root, "daemon", "detach");
    expect(detached.status, detached.stderr).toBe(0);
    expect(detached.stdout).toContain("no Marbles process is running");
    expect((await readWorkspace(state, workspace.id))?.hosted).toBe(false);
  }, 60_000);
});
