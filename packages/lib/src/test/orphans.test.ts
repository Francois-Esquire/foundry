import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stopOrphans } from "../orphans";
import { type ProcessIdentity, startedAt } from "../process-identity";
import {
  recordChild,
  recordPath,
  SPAWN_RECOVERY_ENV,
  type SpawnRecord,
  writePrivate,
} from "../spawn-record";
import { anotherStart } from "../testing/process-identity";

const started: ChildProcess[] = [];
const made: string[] = [];
const FAST = { graceMs: 2000, killMs: 1000 };

afterEach(() => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orphans-"));
  made.push(dir);
  return dir;
}

function sleeper(detached = false): {
  readonly child: ChildProcess;
  readonly identity: ProcessIdentity & { readonly started: string };
} {
  const child = spawn("sleep", ["60"], { detached, stdio: "ignore" });
  started.push(child);
  const { pid } = child;
  const when = pid === undefined ? undefined : startedAt(pid);
  if (pid === undefined || typeof when !== "string") {
    throw new Error("the sleep did not start");
  }
  return { child, identity: { pid, started: when } };
}

function record(dir: string, entry: SpawnRecord): void {
  writePrivate(recordPath(dir, entry.pid), JSON.stringify(entry));
}

async function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.signalCode;
  }
  return await new Promise((settle) =>
    child.once("exit", (_code, signal) => settle(signal))
  );
}

async function kill(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
  await exited(child);
}

it("stops a child whose owner is gone, and removes its record", async () => {
  const dir = scratch();
  const owner = sleeper();
  const orphan = sleeper();
  record(dir, { ...orphan.identity, group: false, owner: owner.identity });
  await kill(owner.child);

  const stop = await stopOrphans(dir, FAST);

  expect(stop).toEqual({ problems: [], stopped: [orphan.identity.pid] });
  expect(await exited(orphan.child)).toBe("SIGTERM");
  expect(existsSync(recordPath(dir, orphan.identity.pid))).toBe(false);
});

it("leaves a child whose owner is alive, and its record", async () => {
  const dir = scratch();
  const owner = sleeper();
  const child = sleeper();
  record(dir, { ...child.identity, group: false, owner: owner.identity });

  expect(await stopOrphans(dir, FAST)).toEqual({ problems: [], stopped: [] });
  expect(child.child.exitCode).toBeNull();
  expect(child.child.signalCode).toBeNull();
  expect(existsSync(recordPath(dir, child.identity.pid))).toBe(true);
});

it("never signals a process that started at another time than its record says", async () => {
  const dir = scratch();
  const owner = sleeper();
  const impostor = sleeper();
  record(dir, {
    group: false,
    owner: owner.identity,
    pid: impostor.identity.pid,
    started: anotherStart(),
  });
  await kill(owner.child);

  expect(await stopOrphans(dir, FAST)).toEqual({ problems: [], stopped: [] });
  expect(impostor.child.exitCode).toBeNull();
  expect(impostor.child.signalCode).toBeNull();
  expect(existsSync(recordPath(dir, impostor.identity.pid))).toBe(false);
});

it("never signals a record without an owner, nor this process", async () => {
  const dir = scratch();
  const lasting = sleeper();
  record(dir, { ...lasting.identity, group: false });
  const self = startedAt(process.pid);
  if (typeof self !== "string") {
    throw new Error("no start time for this process");
  }
  const owner = sleeper();
  record(dir, {
    group: false,
    owner: owner.identity,
    pid: process.pid,
    started: self,
  });
  await kill(owner.child);

  expect(await stopOrphans(dir, FAST)).toEqual({ problems: [], stopped: [] });
  expect(lasting.child.signalCode).toBeNull();
});

it("follows orphans down: a stopped orphan's own children are orphans next", async () => {
  const dir = scratch();
  const owner = sleeper();
  const parent = sleeper();
  const grandchild = sleeper();
  record(dir, { ...parent.identity, group: false, owner: owner.identity });
  record(dir, { ...grandchild.identity, group: false, owner: parent.identity });
  await kill(owner.child);

  const stop = await stopOrphans(dir, FAST);

  expect(stop.problems).toEqual([]);
  expect(stop.stopped).toEqual([parent.identity.pid, grandchild.identity.pid]);
  expect(await exited(grandchild.child)).toBe("SIGTERM");
});

it("stops a group an orphan leads, and refuses one that no longer leads its group", async () => {
  const dir = scratch();
  const owner = sleeper();
  const leader = sleeper(true);
  const follower = sleeper();
  record(dir, { ...leader.identity, group: true, owner: owner.identity });
  record(dir, { ...follower.identity, group: true, owner: owner.identity });
  await kill(owner.child);

  const stop = await stopOrphans(dir, FAST);

  expect(stop.stopped).toEqual([leader.identity.pid]);
  expect(stop.problems).toEqual([
    `process ${String(follower.identity.pid)} was recorded leading its own group and no longer does; not signalled`,
  ]);
  expect(await exited(leader.child)).toBe("SIGTERM");
  expect(follower.child.signalCode).toBeNull();
});

it("kills one that ignores SIGTERM, and keeps the record of one that will not go", async () => {
  const dir = scratch();
  const owner = sleeper();
  const stubborn = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore" }
  );
  started.push(stubborn);
  await new Promise((settle) => setTimeout(settle, 300));
  const pid = stubborn.pid ?? 0;
  const when = startedAt(pid);
  if (typeof when !== "string") {
    throw new Error("no start time");
  }
  record(dir, { group: false, owner: owner.identity, pid, started: when });
  await kill(owner.child);

  const stop = await stopOrphans(dir, { graceMs: 300, killMs: 2000 });

  expect(stop).toEqual({ problems: [], stopped: [pid] });
  expect(await exited(stubborn)).toBe("SIGKILL");

  const unkillable = sleeper();
  record(dir, { ...unkillable.identity, group: false, owner: owner.identity });
  const refused = await stopOrphans(dir, {
    graceMs: 10,
    killMs: 10,
    system: {
      kill: () => undefined,
      look: (pids) =>
        new Map(
          pids
            .filter((each) => each === unkillable.identity.pid)
            .map((each) => [
              each,
              { pgid: each, started: unkillable.identity.started },
            ])
        ),
      members: () => new Map(),
      sleep: () => Promise.resolve(),
    },
  });
  expect(refused.stopped).toEqual([]);
  expect(refused.problems).toEqual([
    `process ${String(unkillable.identity.pid)} would not stop; its record is kept`,
  ]);
  expect(existsSync(recordPath(dir, unkillable.identity.pid))).toBe(true);
});

it("signals nothing when the process table cannot be read", async () => {
  const dir = scratch();
  const owner = sleeper();
  const child = sleeper();
  record(dir, { ...child.identity, group: false, owner: owner.identity });
  await kill(owner.child);
  const stop = await stopOrphans(dir, {
    system: {
      kill: () => {
        throw new Error("never signalled");
      },
      look: () => undefined,
      members: () => undefined,
      sleep: () => Promise.resolve(),
    },
  });
  expect(stop).toEqual({
    problems: ["ps could not list the recorded processes"],
    stopped: [],
  });
  expect(child.child.signalCode).toBeNull();
});

it("passes over a record that is not private or not a record", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "1.json"), "{}", { mode: 0o644 });
  writePrivate(join(dir, "2.json"), JSON.stringify({ pid: "two" }));
  const stop = await stopOrphans(dir, FAST);
  expect(stop.stopped).toEqual([]);
  expect(stop.problems).toEqual([
    expect.stringContaining("is open to group or others"),
    `${join(dir, "2.json")} is not a process record`,
  ]);
  expect(await stopOrphans(join(dir, "missing"), FAST)).toEqual({
    problems: [],
    stopped: [],
  });
});

it("records the owner of a child on its recovery record, and removes it once the child exits", async () => {
  const dir = scratch();
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  started.push(child);
  recordChild(child, false, { [SPAWN_RECOVERY_ENV]: dir });
  const path = recordPath(dir, child.pid ?? 0);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    group: false,
    owner: { pid: process.pid, started: startedAt(process.pid) },
    pid: child.pid,
    started: startedAt(child.pid ?? 0),
  });
  await kill(child);
  expect(existsSync(path)).toBe(false);
});

async function stubbornGroup(dir: string): Promise<{
  readonly helper: ProcessIdentity & { readonly started: string };
  readonly leader: ChildProcess;
  readonly identity: ProcessIdentity & { readonly started: string };
}> {
  const script = join(dir, "helper.js");
  const ready = join(dir, "ready");
  writeFileSync(
    script,
    `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`
  );
  const leader = spawn(
    "/bin/sh",
    ["-c", `'${process.execPath}' '${script}' & wait`],
    {
      detached: true,
      stdio: "ignore",
    }
  );
  started.push(leader);
  for (let i = 0; i < 500 && !existsSync(ready); i += 1) {
    await new Promise((done) => setTimeout(done, 10));
  }
  const pid = Number(readFileSync(ready, "utf8"));
  const helperStart = startedAt(pid);
  const leaderStart = startedAt(leader.pid ?? 0);
  if (typeof helperStart !== "string" || typeof leaderStart !== "string") {
    throw new Error("the group did not start");
  }
  leftovers.push({ pid, started: helperStart });
  return {
    helper: { pid, started: helperStart },
    identity: { pid: leader.pid ?? 0, started: leaderStart },
    leader,
  };
}

const leftovers: { pid: number; started: string }[] = [];
afterEach(() => {
  for (const { pid, started: start } of leftovers.splice(0)) {
    if (startedAt(pid) === start) {
      process.kill(pid, "SIGKILL");
    }
  }
});

it("stops a whole group whose member ignores SIGTERM, and forgets it only once no member is left", async () => {
  const dir = scratch();
  const owner = sleeper();
  const group = await stubbornGroup(dir);
  record(dir, { ...group.identity, group: true, owner: owner.identity });
  await kill(owner.child);

  const stop = await stopOrphans(dir, { graceMs: 300, killMs: 2000 });

  expect(stop).toEqual({ problems: [], stopped: [group.identity.pid] });
  expect(startedAt(group.helper.pid)).toBeNull();
  expect(existsSync(recordPath(dir, group.identity.pid))).toBe(false);
});

it("finishes a group a stop cut short after its leader exited, by the members its record proves", async () => {
  const dir = scratch();
  const owner = sleeper();
  const group = await stubbornGroup(dir);
  record(dir, {
    ...group.identity,
    group: true,
    members: [group.identity, group.helper],
    owner: owner.identity,
  });
  await kill(owner.child);
  await kill(group.leader);

  const stop = await stopOrphans(dir, { graceMs: 300, killMs: 2000 });

  expect(stop).toEqual({ problems: [], stopped: [group.identity.pid] });
  expect(startedAt(group.helper.pid)).toBeNull();
  expect(existsSync(recordPath(dir, group.identity.pid))).toBe(false);
});

it("keeps the record of a group whose leader is gone and whose members it cannot prove, as pending", async () => {
  const dir = scratch();
  const owner = sleeper();
  const group = await stubbornGroup(dir);
  record(dir, { ...group.identity, group: true, owner: owner.identity });
  await kill(owner.child);
  await kill(group.leader);

  const stop = await stopOrphans(dir, FAST);

  expect(stop.stopped).toEqual([]);
  expect(stop.problems).toEqual([
    `group ${String(group.identity.pid)}'s leader is gone and its 1 remaining member(s) cannot be proved its; not signalled, pending, its record kept`,
  ]);
  expect(startedAt(group.helper.pid)).toBe(group.helper.started);
  expect(existsSync(recordPath(dir, group.identity.pid))).toBe(true);
});

it("keeps, and reports, a record whose start is of another kind than the system reads", async () => {
  const dir = scratch();
  record(dir, {
    group: false,
    owner: { pid: 456, started: null },
    pid: 123,
    started: "Sun Nov 15 12:00:00 2026",
  });
  const stop = await stopOrphans(dir, {
    system: {
      kill: () => {
        throw new Error("never signalled");
      },
      look: () =>
        new Map([[123, { pgid: 123, started: "ps:Sun Nov 15 12:00:00 2026" }]]),
      members: () => new Map(),
      sleep: () => Promise.resolve(),
    },
  });
  expect(stop).toEqual({
    problems: [
      "process 123 runs, and its record names a start of another kind than this system reads; not signalled, its record kept",
    ],
    stopped: [],
  });
  expect(existsSync(recordPath(dir, 123))).toBe(true);
});
