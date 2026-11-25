import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  groupMembers,
  nodeStartedAt,
  type SeenProcess,
  thisProcess,
} from "../node/process-identity";
import {
  type GroupStopResult,
  type ProcessGroupOps,
  recordGroup,
  recordPath,
  SPAWN_RECOVERY_ENV,
  type SpawnRecord,
  writePrivate,
} from "../node/spawn-record";
import { signalOwn, stopLeftover } from "./helpers/leftovers";
import { pidWritten } from "./helpers/pid-file";

const made: string[] = [];
const leftovers: { pid: number; started: string }[] = [];

afterEach(() => {
  for (const { pid, started } of leftovers.splice(0)) {
    stopLeftover(pid, started);
  }
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

async function group(
  then: string,
  record: (child: ChildProcess, dir: string) => () => Promise<GroupStopResult>
): Promise<{
  readonly child: ChildProcess;
  readonly dir: string;
  readonly sleep: number;
  readonly stop: () => Promise<GroupStopResult>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "record-group-"));
  made.push(dir);
  const child = spawn(
    "/bin/sh",
    ["-c", `sleep 60 & echo $! > '${dir}/pid'; ${then}`],
    { detached: true, stdio: "ignore" }
  );
  const stop = record(child, dir);
  const sleep = await pidWritten(join(dir, "pid"));
  const started = nodeStartedAt(sleep);
  if (typeof started === "string") {
    leftovers.push({ pid: sleep, started });
  }
  return { child, dir, sleep, stop };
}

function records(dir: string): string[] {
  const at = join(dir, "records");
  return existsSync(at)
    ? readdirSync(at).filter((name) => name.endsWith(".json"))
    : [];
}

async function goneSoon(pid: number): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    if (nodeStartedAt(pid) === null) {
      return true;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  return false;
}

it("stops the whole group when its call aborts, and forgets it once it is empty", async () => {
  const control = new AbortController();
  const { child, dir, sleep, stop } = await group("wait", (spawned, at) =>
    recordGroup(spawned, {
      env: { [SPAWN_RECOVERY_ENV]: join(at, "records") },
      signal: control.signal,
    })
  );
  expect(records(dir)).toEqual([`${String(child.pid)}.json`]);
  control.abort();
  expect((await stop()).emptied).toBe(true);
  expect(await goneSoon(sleep)).toBe(true);
  expect(records(dir)).toEqual([]);
});

it("stops what the leader left in its group when it exits on its own", async () => {
  const { child, dir, sleep, stop } = await group("exit 0", (spawned, at) =>
    recordGroup(spawned, {
      env: { [SPAWN_RECOVERY_ENV]: join(at, "records") },
    })
  );
  if (child.exitCode === null) {
    await new Promise((done) => child.once("exit", done));
  }
  expect((await stop()).emptied).toBe(true);
  expect(await goneSoon(sleep)).toBe(true);
  expect(records(dir)).toEqual([]);
});

it("keeps the record of a group that would not empty, its members written before the first signal, for the next start", async () => {
  const signalled: (NodeJS.Signals | 0)[] = [];
  let recordedAtTerm: SpawnRecord | undefined;
  const { child, dir, sleep, stop } = await group("wait", (spawned, at) =>
    recordGroup(spawned, {
      env: { [SPAWN_RECOVERY_ENV]: join(at, "records") },
      graceMs: 30,
      killMs: 30,
      system: {
        kill: (_target, signal) => {
          signalled.push(signal);
          if (signal === "SIGTERM") {
            recordedAtTerm = JSON.parse(
              readFileSync(
                recordPath(join(at, "records"), spawned.pid ?? 0),
                "utf8"
              )
            ) as SpawnRecord;
          }
        },
        members: groupMembers,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      },
    })
  );
  expect((await stop()).emptied).toBe(false);
  expect(recordedAtTerm?.members).toEqual(
    expect.arrayContaining([
      { pid: child.pid, started: nodeStartedAt(child.pid ?? 0) },
      { pid: sleep, started: nodeStartedAt(sleep) },
    ])
  );
  expect(recordedAtTerm?.owner).toEqual(thisProcess());
  expect(signalled).toContain("SIGTERM");
  expect(signalled).toContain("SIGKILL");
  expect(records(dir)).toEqual([`${String(child.pid)}.json`]);
  expect(existsSync(recordPath(join(dir, "records"), child.pid ?? 0))).toBe(
    true
  );
  signalOwn(-(child.pid ?? 0), "SIGKILL");
});

function madeUpChild(pid: number): {
  readonly child: Parameters<typeof recordGroup>[0];
  readonly exit: () => void;
} {
  let onExit: (() => void) | undefined;
  const child = {
    exitCode: null as number | null,
    once(event: string, listener: () => void) {
      if (event === "exit") {
        onExit = listener;
      }
      return child;
    },
    pid,
    signalCode: null as NodeJS.Signals | null,
  };
  return {
    child: child as unknown as Parameters<typeof recordGroup>[0],
    exit: () => {
      child.exitCode = 0;
      onExit?.();
    },
  };
}

const MADE_UP = "ps:Sun Nov 15 08:00:00 2026";
const LATER = "ps:Sun Nov 15 09:00:00 2026";

it("sends no SIGKILL to a group id that went to another group during the grace period", async () => {
  const pgid = 4_200_040;
  const { child, exit } = madeUpChild(pgid);
  let members = new Map<number, SeenProcess>([
    [4_200_041, { pgid, started: MADE_UP }],
  ]);
  const sent: [number, NodeJS.Signals | 0][] = [];
  const system: ProcessGroupOps = {
    kill(target, signal) {
      sent.push([target, signal]);
      if (signal === "SIGTERM") {
        members = new Map([[4_200_042, { pgid, started: LATER }]]);
      }
    },
    members: () => members,
    sleep: () => Promise.resolve(),
  };
  const stop = recordGroup(child, { env: {}, graceMs: 0, killMs: 0, system });
  exit();
  expect((await stop()).emptied).toBe(false);
  expect(sent.filter(([, signal]) => signal !== 0)).toEqual([
    [-pgid, "SIGTERM"],
  ]);
});

it("takes a group left only with exited, unreaped members (zombies) for empty", async () => {
  const pgid = 4_200_050;
  const { child, exit } = madeUpChild(pgid);
  const sent: [number, NodeJS.Signals | 0][] = [];
  const system: ProcessGroupOps = {
    kill(target, signal) {
      sent.push([target, signal]);
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    members: () =>
      new Map([[4_200_051, { exited: true, pgid, started: MADE_UP }]]),
    sleep: () => Promise.resolve(),
  };
  const stop = recordGroup(child, { env: {}, system });
  exit();
  expect((await stop()).emptied).toBe(true);
  expect(sent).toEqual([[-pgid, 0]]);
});

it("sends nothing to a group id another process leads once the leader is reaped: it was emptied before", async () => {
  const pgid = 4_200_060;
  const { child, exit } = madeUpChild(pgid);
  const sent: [number, NodeJS.Signals | 0][] = [];
  const system: ProcessGroupOps = {
    kill(target, signal) {
      sent.push([target, signal]);
    },
    members: () =>
      new Map([
        [pgid, { pgid, started: LATER }],
        [4_200_061, { pgid, started: LATER }],
      ]),
    sleep: () => Promise.resolve(),
  };
  const stop = recordGroup(child, { env: {}, system });
  exit();
  expect((await stop()).emptied).toBe(true);
  expect(sent).toEqual([[-pgid, 0]]);
});

function recordedIn(pgid: number): {
  readonly dir: string;
  readonly path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "record-group-"));
  made.push(dir);
  const path = recordPath(dir, pgid);
  writePrivate(
    path,
    JSON.stringify({
      group: true,
      owner: thisProcess(),
      pid: pgid,
      started: MADE_UP,
    })
  );
  return { dir, path };
}

it("tries writing the members again once, and saves them when the second write goes through", async () => {
  const pgid = 4_200_070;
  const { dir, path } = recordedIn(pgid);
  const { child, exit } = madeUpChild(pgid);
  const writes: string[] = [];
  const reports: string[] = [];
  let members = new Map<number, SeenProcess>([
    [4_200_071, { pgid, started: MADE_UP }],
  ]);
  const read: (readonly unknown[] | undefined)[] = [];
  const system: ProcessGroupOps = {
    kill(_target, signal) {
      if (signal === 0 && members.size === 0) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      if (signal === "SIGTERM") {
        read.push(
          (JSON.parse(readFileSync(path, "utf8")) as SpawnRecord).members
        );
        members = new Map();
      }
    },
    members: () => members,
    report: (line) => reports.push(line),
    sleep: () => Promise.resolve(),
    write(at, text) {
      writes.push(at);
      if (writes.length === 1) {
        throw new Error("disk full");
      }
      writePrivate(at, text);
    },
  };
  const stop = recordGroup(child, {
    env: { [SPAWN_RECOVERY_ENV]: dir },
    graceMs: 0,
    killMs: 0,
    system,
  });
  exit();
  expect(await stop()).toEqual({ emptied: true, saved: true });
  expect(writes).toEqual([path, path]);
  expect(reports).toEqual([]);
  expect(read).toEqual([[{ pid: 4_200_071, started: MADE_UP }]]);
});

it("reports members it could not save, says so, and stops its group all the same", async () => {
  const pgid = 4_200_080;
  const { dir, path } = recordedIn(pgid);
  const { child, exit } = madeUpChild(pgid);
  const reports: string[] = [];
  const sent: [number, NodeJS.Signals | 0][] = [];
  let members = new Map<number, SeenProcess>([
    [4_200_081, { pgid, started: MADE_UP }],
  ]);
  let writes = 0;
  const system: ProcessGroupOps = {
    kill(target, signal) {
      if (signal === 0 && members.size === 0) {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      }
      sent.push([target, signal]);
      if (signal === "SIGTERM") {
        members = new Map();
      }
    },
    members: () => members,
    report: (line) => reports.push(line),
    sleep: () => Promise.resolve(),
    write() {
      writes += 1;
      throw new Error("read-only file system");
    },
  };
  const stop = recordGroup(child, {
    env: { [SPAWN_RECOVERY_ENV]: dir },
    graceMs: 0,
    killMs: 0,
    system,
  });
  exit();
  expect(await stop()).toEqual({ emptied: true, saved: false });
  expect(writes).toBe(2);
  expect(reports).toEqual([
    expect.stringContaining(
      `could not save the members of group ${String(pgid)} into its recovery record ${path}`
    ),
  ]);
  expect(reports[0]).toContain("read-only file system");
  expect(sent.filter(([, signal]) => signal !== 0)).toEqual([
    [-pgid, "SIGTERM"],
  ]);
});

it("keeps the record of a group the listing shows empty while a signal still reaches it, once its leader is reaped, and reports it", async () => {
  const pgid = 4_200_180;
  const { dir, path } = recordedIn(pgid);
  const { child, exit } = madeUpChild(pgid);
  const reports: string[] = [];
  const sent: [number, NodeJS.Signals | 0][] = [];
  const system: ProcessGroupOps = {
    kill(target, signal) {
      sent.push([target, signal]);
    },
    members: () => new Map(),
    report: (line) => reports.push(line),
    sleep: () => Promise.resolve(),
  };
  const stop = recordGroup(child, {
    env: { [SPAWN_RECOVERY_ENV]: dir },
    graceMs: 0,
    killMs: 0,
    system,
  });
  exit();
  expect((await stop()).emptied).toBe(false);
  expect(sent.filter(([, signal]) => signal !== 0)).toEqual([]);
  expect(existsSync(path)).toBe(true);
  expect(reports).toEqual([
    expect.stringContaining("a signal still reaches it"),
  ]);
});

it("stops its own unreaped leader's group even when the group cannot be listed, and reports a reaped one it cannot list", async () => {
  const pgid = 4_200_630;
  const reports: string[] = [];
  const sent: [number, NodeJS.Signals | 0][] = [];
  const system: ProcessGroupOps = {
    kill: (target, signal) => {
      sent.push([target, signal]);
    },
    members: () => undefined,
    report: (line) => reports.push(line),
    sleep: () => Promise.resolve(),
  };
  const held = madeUpChild(pgid);
  const stop = recordGroup(held.child, {
    env: {},
    graceMs: 0,
    killMs: 0,
    system,
  });
  expect((await stop()).emptied).toBe(false);
  expect(sent.filter(([, signal]) => signal !== 0)).toEqual([
    [-pgid, "SIGTERM"],
    [-pgid, "SIGKILL"],
  ]);
  expect(reports).toEqual([expect.stringContaining("could not be listed")]);

  reports.length = 0;
  sent.length = 0;
  const reaped = madeUpChild(pgid + 1);
  const later = recordGroup(reaped.child, {
    env: {},
    graceMs: 0,
    killMs: 0,
    system,
  });
  reaped.exit();
  expect(await later()).toEqual({ emptied: false, saved: true });
  expect(sent.filter(([, signal]) => signal !== 0)).toEqual([]);
  expect(reports).toEqual([expect.stringContaining("could not be listed")]);
});

it("does not take a leader whose exit has already happened for its own unreaped child", async () => {
  const pgid = 4_200_710;
  const reports: string[] = [];
  const sent: [number, NodeJS.Signals | 0][] = [];
  const system: ProcessGroupOps = {
    kill: (target, signal) => {
      sent.push([target, signal]);
    },
    members: () => undefined,
    report: (line) => reports.push(line),
    sleep: () => Promise.resolve(),
  };
  const child = {
    exitCode: 0,
    once() {
      return child;
    },
    pid: pgid,
    signalCode: null,
  } as unknown as Parameters<typeof recordGroup>[0];
  const stop = recordGroup(child, { env: {}, graceMs: 0, killMs: 0, system });
  expect((await stop()).emptied).toBe(false);
  expect(sent.filter(([, signal]) => signal !== 0)).toEqual([]);
  expect(reports).toEqual([expect.stringContaining("its leader is reaped")]);
});
