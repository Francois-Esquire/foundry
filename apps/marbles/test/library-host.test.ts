import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lockHolder } from "@foundry/lib/file-lock";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncompatibleDatabaseError, MIGRATIONS } from "~/database/migrate";
import { initializeDatabase, readDatabase } from "~/database/open";
import { WorkspaceRegistry } from "~/database/workspaces";
import { layout, stateDatabase } from "~/layout";
import { acquireLock, PROCESS_LOCK } from "~/lib/state/locks";
import { workspaceState } from "~/lib/state/workspace";
import { type Daemon, startDaemon } from "~/process/daemon";
import { claimProcess } from "~/process/instance";
import { readWorkspace, recordWorkspace } from "./helpers/registry";

const SRC = resolve("src");
const daemons: Daemon[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "mlh-"));
}

const processLock = (state: string) => join(state, "locks", PROCESS_LOCK);

/** Migrations with one more after the committed ones: a build newer than the database. */
function newerBuild(dir: string): string {
  const folder = join(dir, "migrations-next");
  cpSync(MIGRATIONS, folder, { recursive: true });
  const path = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(path, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const last = journal.entries.at(-1);
  if (last === undefined) {
    throw new Error("no migrations are committed");
  }
  journal.entries.push({ ...last, tag: "9999_probe", when: last.when + 1 });
  writeFileSync(path, JSON.stringify(journal));
  writeFileSync(
    join(folder, "9999_probe.sql"),
    "CREATE TABLE `marbles_probe` (`id` text PRIMARY KEY NOT NULL);"
  );
  return folder;
}

function journalLength(folder: string): number {
  return (
    JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as {
      entries: unknown[];
    }
  ).entries.length;
}

/** How many migrations the database under `state` has applied, read by the build `folder` ships. */
async function applied(
  state: string,
  folder: string = MIGRATIONS
): Promise<number> {
  const opened = await initializeDatabase(stateDatabase(state), {
    migrations: folder,
  });
  try {
    const [row] = await opened.database.values<[number]>(
      sql`SELECT count(*) FROM __drizzle_migrations`
    );
    return Number(row?.[0]);
  } finally {
    opened.close();
  }
}

/** A database under `state` migrated with this build's committed migrations. */
async function current(state: string): Promise<void> {
  (await initializeDatabase(stateDatabase(state))).close();
}

describe("a program hosting a workspace itself", () => {
  it("records it on a state root no Marbles process ever ran on", async () => {
    const root = scratch();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "marbles.ts"), "");
    const state = join(root, "state");
    const script = join(root, "host.ts");
    writeFileSync(
      script,
      `import { hostWorkspace } from ${JSON.stringify(join(SRC, "workspace/host.ts"))};
const host = await hostWorkspace({
  artifacts: ${JSON.stringify(join(root, "artifacts"))},
  source: ${JSON.stringify(join(workspace, "marbles.ts"))},
  state: ${JSON.stringify(state)},
});
await host.close();
`
    );
    const hosted = spawnSync("bun", ["--no-env-file", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(hosted.status, hosted.stderr).toBe(0);
    const { id } = workspaceState(state, workspace);
    expect(await readWorkspace(state, id)).toMatchObject({ hosted: false, id });
    // The lock it made the database under is let go.
    expect(lockHolder(processLock(state))).toBeUndefined();
  }, 60_000);

  it("migrates a database that is behind when no other process holds the state root", async () => {
    const state = join(scratch(), "state");
    await current(state);
    const next = newerBuild(scratch());
    const workspace = workspaceState(state, scratch());
    await recordWorkspace(state, workspace, null, { migrations: next });
    expect(await applied(state, next)).toBe(journalLength(next));
    const record = await readDatabase(
      stateDatabase(state),
      (database) =>
        new WorkspaceRegistry({ database, state }).read(workspace.id),
      { migrations: next }
    );
    expect(record?.id).toBe(workspace.id);
    expect(lockHolder(processLock(state))).toBeUndefined();
  });

  it("holds the state root's lock while it migrates, and lets it go before it records", async () => {
    const state = join(scratch(), "state");
    const workspace = workspaceState(state, scratch());
    const seen: (number | undefined)[] = [];
    const { touch } = WorkspaceRegistry.prototype;
    vi.spyOn(WorkspaceRegistry.prototype, "touch").mockImplementation(function (
      this: WorkspaceRegistry,
      ...args
    ) {
      seen.push(lockHolder(processLock(state)));
      return touch.apply(this, args);
    });
    await recordWorkspace(state, workspace, null);
    // It made and migrated the database, under the lock no one else held.
    expect((await readWorkspace(state, workspace.id))?.id).toBe(workspace.id);
    expect(seen).toEqual([undefined]);
    expect(lockHolder(processLock(state))).toBeUndefined();
  });

  it("never migrates while a Marbles process holds the state root", async () => {
    const state = join(scratch(), "state");
    await current(state);
    const claim = claimProcess(state, { host: "daemon" });
    try {
      const next = newerBuild(scratch());
      await expect(
        recordWorkspace(state, workspaceState(state, scratch()), null, {
          migrations: next,
          wait: 200,
        })
      ).rejects.toBeInstanceOf(IncompatibleDatabaseError);
      expect(await applied(state)).toBe(journalLength(MIGRATIONS));
      // The claim is still the Marbles process's.
      expect(lockHolder(processLock(state))).toBe(process.pid);
    } finally {
      claim.release();
    }
  });

  it("waits for another host that holds the state root, then makes the database itself", async () => {
    const state = join(scratch(), "state");
    const lock = acquireLock(state, PROCESS_LOCK);
    if (!("release" in lock)) {
      throw new Error("the lock was not free");
    }
    const workspace = workspaceState(state, scratch());
    const recording = recordWorkspace(state, workspace, null, { wait: 5000 });
    await new Promise((settle) => setTimeout(settle, 200));
    lock.release();
    await recording;
    expect((await readWorkspace(state, workspace.id))?.id).toBe(workspace.id);
  });

  it("starts beside another host, both recorded and the database migrated once", async () => {
    const root = scratch();
    const state = join(root, "state");
    const go = join(root, "go");
    const hosts = ["a", "b"].map((name) => {
      const workspace = join(root, name);
      mkdirSync(workspace);
      const script = join(root, `${name}.ts`);
      writeFileSync(
        script,
        `import { existsSync } from "node:fs";
import { recordWorkspace } from ${JSON.stringify(resolve("test/helpers/registry.ts"))};
import { workspaceState } from ${JSON.stringify(join(SRC, "lib/state/workspace.ts"))};
process.stdout.write("ready\\n");
while (!existsSync(${JSON.stringify(go)})) {
  await new Promise((settle) => setTimeout(settle, 5));
}
const state = ${JSON.stringify(state)};
await recordWorkspace(state, workspaceState(state, ${JSON.stringify(workspace)}), null);
`
      );
      const child = spawn("bun", [script], {
        cwd: resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      return {
        exited: new Promise<{ code: number | null; stderr: string }>((settle) =>
          child.once("exit", (code) => settle({ code, stderr }))
        ),
        ready: new Promise<void>((ready) => {
          child.stdout?.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("ready")) {
              ready();
            }
          });
        }),
        workspace,
      };
    });
    await Promise.all(hosts.map((host) => host.ready));
    writeFileSync(go, "");
    for (const { code, stderr } of await Promise.all(
      hosts.map((host) => host.exited)
    )) {
      expect(code, stderr).toBe(0);
    }
    for (const host of hosts) {
      const { id } = workspaceState(state, host.workspace);
      expect((await readWorkspace(state, id))?.id).toBe(id);
    }
    expect(await applied(state)).toBe(journalLength(MIGRATIONS));
    expect(lockHolder(processLock(state))).toBeUndefined();
  }, 60_000);

  it("records beside a Marbles process in its own process without taking its claim", async () => {
    const home = mkdtempSync(join(tmpdir(), "mb-"));
    const machine = layout({ home });
    const daemon = await startDaemon({ layout: machine });
    daemons.push(daemon);
    const workspace = workspaceState(machine.state, scratch());
    await recordWorkspace(machine.state, workspace, null);
    expect((await readWorkspace(machine.state, workspace.id))?.id).toBe(
      workspace.id
    );
    expect(lockHolder(processLock(machine.state))).toBe(process.pid);
  });
});
