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
import { lockHolder } from "@foundry/lib/node/file-lock";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncompatibleDatabaseError, MIGRATIONS } from "~/database/migrate";
import { initializeDatabase, readDatabase } from "~/database/open";
import { WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import { acquireLock, PROCESS_LOCK } from "~/lib/state/locks";
import { insideState, workspaceState } from "~/lib/state/workspace";
import { type Daemon, startDaemon } from "~/process/daemon";
import { recordSpawned } from "~/process/spawned";
import { testHome } from "./helpers/home";
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
        new WorkspaceRegistry({
          acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
          database,
        }).read(workspace.id),
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
    expect((await readWorkspace(state, workspace.id))?.id).toBe(workspace.id);
    expect(seen).toEqual([undefined]);
    expect(lockHolder(processLock(state))).toBeUndefined();
  });

  it("never migrates while a Marbles process holds the state root", async () => {
    const state = join(scratch(), "state");
    await current(state);
    const script = join(scratch(), "daemon-claim.ts");
    writeFileSync(
      script,
      `import { claimProcess } from ${JSON.stringify(join(SRC, "process/instance.ts"))};
claimProcess(${JSON.stringify(state)}, { host: "daemon" });
process.stdout.write("claimed\\n");
setInterval(() => undefined, 1000);
`
    );
    const daemon = spawn("bun", [script], { cwd: resolve(".") });
    recordSpawned(daemon.pid, false);
    try {
      await new Promise<void>((ready, failed) => {
        daemon.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("claimed")) {
            ready();
          }
        });
        daemon.once("exit", (code) => failed(new Error(`exited ${code}`)));
      });
      const next = newerBuild(scratch());
      await expect(
        recordWorkspace(state, workspaceState(state, scratch()), null, {
          migrations: next,
          wait: 200,
        })
      ).rejects.toBeInstanceOf(IncompatibleDatabaseError);
      expect(await applied(state)).toBe(journalLength(MIGRATIONS));
      expect(lockHolder(processLock(state))).toBe(daemon.pid);
    } finally {
      daemon.kill("SIGKILL");
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
      recordSpawned(child.pid, false);
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
    const machine = testHome({ providers: false }).layout;
    const daemon = await startDaemon({ layout: machine });
    daemons.push(daemon);
    const workspace = workspaceState(machine.state, scratch());
    await recordWorkspace(machine.state, workspace, null);
    expect((await readWorkspace(machine.state, workspace.id))?.id).toBe(
      workspace.id
    );
    expect(lockHolder(processLock(machine.state))).toBe(daemon.pid);
  });
});
