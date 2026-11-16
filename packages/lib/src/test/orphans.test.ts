import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type ProcessTable, stopOrphans } from "../orphans";
import {
  type ProcessIdentity,
  type SeenProcess,
  startedAt,
} from "../process-identity";
import {
  forgetRecord,
  recordChild,
  recordPath,
  SPAWN_RECOVERY_ENV,
  type SpawnRecord,
  writePrivate,
} from "../spawn-record";
import { anotherStart } from "../testing/process-identity";
import { stopLeftover } from "./helpers/leftovers";
import { pidWritten } from "./helpers/pid-file";

/**
 * Every process here is one this test started (`sleep`), and the only
 * ones a stop may signal: each record names one of them, its owner
 * another. Whatever is still running at the end is stopped by its pid,
 * which this process has not reaped, so no other process can have it.
 */
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

/** A `sleep` of this test's, with its identity. */
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
  // The pid is live, but the record was of another process given it before.
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
  // It names no process now.
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
  // Recorded as leading a group, but it is in this test's.
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
  // Its handler is in place once it has had a moment to start.
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
      alive: (each) => each === unkillable.identity.pid,
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
      alive: () => true,
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

/**
 * A group this test starts, leading its own: a shell that starts a Node
 * process ignoring SIGTERM, which writes its pid once its handler is in
 * place. The helper's identity, for proving and, at the end, stopping it.
 */
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
  const pid = await pidWritten(ready);
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
    stopLeftover(pid, start);
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
  // What a stop cut short leaves: the members it wrote down, the leader gone.
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
      alive: (pid) => pid === 123,
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

/**
 * A table of made-up processes, by pid: a signal to a pid, or to a group
 * by its id, ends each one it reaches that is running; one that has
 * exited (a zombie) stays listed, as no signal reaches it. Every signal
 * is kept in `sent`; none reaches a real process.
 */
function madeUpTable(
  processes: Map<number, SeenProcess>,
  afterKill: (target: number, name: NodeJS.Signals) => void = () => undefined,
  /** Processes a signal reaches that the listing leaves out. */
  unlisted: ReadonlySet<number> = new Set()
): {
  readonly sent: [number, NodeJS.Signals][];
  readonly table: ProcessTable;
} {
  const sent: [number, NodeJS.Signals][] = [];
  const pick = (keep: (pid: number, seen: SeenProcess) => boolean) =>
    new Map([...processes].filter(([pid, seen]) => keep(pid, seen)));
  return {
    sent,
    table: {
      alive: (pid) => processes.has(pid) || unlisted.has(pid),
      kill(target, name) {
        sent.push([target, name]);
        for (const [pid, seen] of processes) {
          const reached = target < 0 ? seen.pgid === -target : pid === target;
          if (reached && seen.exited !== true) {
            processes.delete(pid);
          }
        }
        afterKill(target, name);
      },
      look: (pids) => pick((pid) => pids.includes(pid)),
      members: (pgid) => pick((_pid, seen) => seen.pgid === pgid),
      sleep: () => Promise.resolve(),
    },
  };
}

const MADE_UP = "ps:Sun Nov 15 08:00:00 2026";
const FORGET_ASIDE = /^\.\d+\.json\..+\.forget\.json$/;
const OWNER = { pid: 4_200_000, started: MADE_UP };

it("takes a recorded process that has exited and is not reaped (a zombie) for gone, and signals nothing", async () => {
  const dir = scratch();
  record(dir, { group: false, owner: OWNER, pid: 4_200_001, started: MADE_UP });
  const { sent, table } = madeUpTable(
    new Map([[4_200_001, { exited: true, pgid: 4_200_001, started: MADE_UP }]])
  );
  expect(await stopOrphans(dir, { system: table })).toEqual({
    problems: [],
    stopped: [],
  });
  expect(sent).toEqual([]);
  expect(existsSync(recordPath(dir, 4_200_001))).toBe(false);
});

it("takes an owner that has exited and is not reaped (a zombie) for gone, so its children are stopped", async () => {
  const dir = scratch();
  record(dir, { group: false, owner: OWNER, pid: 4_200_002, started: MADE_UP });
  const { sent, table } = madeUpTable(
    new Map([
      [OWNER.pid, { exited: true, pgid: OWNER.pid, started: MADE_UP }],
      [4_200_002, { pgid: OWNER.pid, started: MADE_UP }],
    ])
  );
  expect(
    await stopOrphans(dir, { graceMs: 0, killMs: 0, system: table })
  ).toEqual({ problems: [], stopped: [4_200_002] });
  expect(sent).toEqual([[4_200_002, "SIGTERM"]]);
});

it("forgets a group whose leader is gone once only exited, unreaped members (zombies) are left", async () => {
  const dir = scratch();
  record(dir, {
    group: true,
    members: [{ pid: 4_200_004, started: MADE_UP }],
    owner: OWNER,
    pid: 4_200_003,
    started: MADE_UP,
  });
  const { sent, table } = madeUpTable(
    new Map([[4_200_004, { exited: true, pgid: 4_200_003, started: MADE_UP }]])
  );
  expect(await stopOrphans(dir, { system: table })).toEqual({
    problems: [],
    stopped: [],
  });
  expect(sent).toEqual([]);
  expect(existsSync(recordPath(dir, 4_200_003))).toBe(false);
});

const LATER = "ps:Sun Nov 15 09:00:00 2026";

it("proves a group again before it records or signals it: one whose id went to another group meanwhile gets nothing, and is known empty", async () => {
  const dir = scratch();
  const leader = 4_200_010;
  record(dir, { group: true, owner: OWNER, pid: leader, started: MADE_UP });
  const processes = new Map<number, SeenProcess>([
    [leader, { pgid: leader, started: MADE_UP }],
  ]);
  const { sent, table } = madeUpTable(processes);
  let looked = false;
  const system: ProcessTable = {
    ...table,
    look(pids) {
      const seen = table.look(pids);
      if (!looked) {
        // Proved as the records are read; then, while other orphans are
        // stopped, the group exits and its id goes to another group.
        looked = true;
        processes.clear();
        processes.set(leader, { pgid: leader, started: LATER });
        processes.set(4_200_011, { pgid: leader, started: LATER });
      }
      return seen;
    },
  };

  const stop = await stopOrphans(dir, { graceMs: 0, killMs: 0, system });

  // Nothing is sent to the other group. Its id being another's proves the
  // old group empty (a pid is not given to a new process while a group
  // with that id has a member), so the record goes.
  expect(sent).toEqual([]);
  expect(stop).toEqual({ problems: [], stopped: [] });
  expect(existsSync(recordPath(dir, leader))).toBe(false);
});

it("signals a group by its id only while a recorded member is proved in it: not once its id is another group's, which proves it empty", async () => {
  const dir = scratch();
  const leader = 4_200_020;
  const stubborn = 4_200_021;
  record(dir, { group: true, owner: OWNER, pid: leader, started: MADE_UP });
  const processes = new Map<number, SeenProcess>([
    [leader, { pgid: leader, started: MADE_UP }],
    [stubborn, { pgid: leader, started: MADE_UP }],
  ]);
  const { sent, table } = madeUpTable(processes, (target, name) => {
    if (target === -leader && name === "SIGTERM") {
      // The group empties, and before the SIGKILL its id is another's.
      processes.set(leader, { pgid: leader, started: LATER });
      processes.set(4_200_022, { pgid: leader, started: LATER });
    }
  });

  const stop = await stopOrphans(dir, { graceMs: 0, killMs: 0, system: table });

  // No SIGKILL to the other group; its id being another's proves the
  // stopped group empty, so its record goes.
  expect(sent).toEqual([[-leader, "SIGTERM"]]);
  expect(stop.problems).toEqual([]);
  expect(existsSync(recordPath(dir, leader))).toBe(false);
});

it("never takes an owner a signal still reaches for gone because the listing left it out, and says so", async () => {
  const dir = scratch();
  const child = 4_200_120;
  const owner = { pid: 4_200_121, started: MADE_UP };
  record(dir, { group: false, owner, pid: child, started: MADE_UP });
  const { sent, table } = madeUpTable(
    new Map([[child, { pgid: child, started: MADE_UP }]]),
    () => undefined,
    new Set([owner.pid])
  );
  expect(
    await stopOrphans(dir, { graceMs: 0, killMs: 0, system: table })
  ).toEqual({
    problems: [
      expect.stringContaining(
        `owner ${String(owner.pid)} of process ${String(child)} cannot be told gone or running: it is not listed but a signal still reaches it`
      ),
    ],
    stopped: [],
  });
  expect(sent).toEqual([]);
  expect(existsSync(recordPath(dir, child))).toBe(true);
});

it("forgets a record left aside by a removal cut short, by the file it read it from", async () => {
  const dir = scratch();
  const gone = { group: false, owner: OWNER, pid: 4_200_140, started: MADE_UP };
  const path = recordPath(dir, gone.pid);
  record(dir, gone);
  // Cut short right after the move aside: the record is there under its
  // aside name only.
  expect(() =>
    forgetRecord(path, gone, {
      link: () => {
        throw new Error("the host stopped");
      },
      read: () => {
        throw new Error("the host stopped");
      },
      remove: () => {
        throw new Error("the host stopped");
      },
      rename: (from, to) => renameSync(from, to),
    })
  ).toThrow("the host stopped");
  expect(readdirSync(dir)).toEqual([expect.stringMatching(FORGET_ASIDE)]);
  const { sent, table } = madeUpTable(new Map());
  expect(await stopOrphans(dir, { system: table })).toEqual({
    problems: [],
    stopped: [],
  });
  expect(sent).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);

  // One left aside that still names an orphan is stopped, then forgotten.
  const orphan = { ...gone, pid: 4_200_141 };
  const aside = join(dir, `.${String(orphan.pid)}.json.left.forget.json`);
  writePrivate(aside, JSON.stringify(orphan));
  const running = madeUpTable(
    new Map([[orphan.pid, { pgid: orphan.pid, started: MADE_UP }]])
  );
  expect(
    await stopOrphans(dir, { graceMs: 0, killMs: 0, system: running.table })
  ).toEqual({ problems: [], stopped: [orphan.pid] });
  expect(running.sent).toEqual([[orphan.pid, "SIGTERM"]]);
  expect(readdirSync(dir)).toEqual([]);
});

/**
 * A table where each listed process is as given, and a signal reaches
 * each pid in `answering` (and every listed one); nothing is signalled.
 */
function judged(
  listed: Map<number, SeenProcess>,
  answering: ReadonlySet<number>
): { readonly sent: unknown[]; readonly table: ProcessTable } {
  const sent: unknown[] = [];
  return {
    sent,
    table: {
      alive: (pid) => listed.has(pid) || answering.has(pid),
      kill: (...args) => {
        sent.push(args);
        throw new Error("nothing here may be signalled");
      },
      look: (pids) =>
        new Map([...listed].filter(([pid]) => pids.includes(pid))),
      members: (pgid) =>
        new Map([...listed].filter(([, seen]) => seen.pgid === pgid)),
      sleep: () => Promise.resolve(),
    },
  };
}

it("keeps, and reports, the record of a process the listing leaves out that a signal still reaches, whoever it is: child, leader or member", async () => {
  const child = 4_200_150;
  const leader = 4_200_151;
  const member = 4_200_152;
  const owner = { pid: 4_200_159, started: MADE_UP };
  const cases: [string, SpawnRecord, number][] = [
    ["child", { group: false, owner, pid: child, started: MADE_UP }, child],
    ["leader", { group: true, owner, pid: leader, started: MADE_UP }, leader],
    [
      "member",
      {
        group: true,
        members: [{ pid: member, started: MADE_UP }],
        owner,
        pid: leader,
        started: MADE_UP,
      },
      member,
    ],
  ];
  for (const [kind, entry, answering] of cases) {
    const dir = scratch();
    record(dir, entry);
    const { sent, table } = judged(new Map(), new Set([answering]));
    const stop = await stopOrphans(dir, {
      graceMs: 0,
      killMs: 0,
      system: table,
    });
    expect({ kind, sent, stopped: stop.stopped }).toEqual({
      kind,
      sent: [],
      stopped: [],
    });
    expect({ kind, problems: stop.problems }).toEqual({
      kind,
      problems: [expect.stringContaining("a signal still reaches it")],
    });
    expect({ kept: existsSync(recordPath(dir, entry.pid)), kind }).toEqual({
      kept: true,
      kind,
    });
  }
});

it("forgets the record of a process gone on proof: unlisted with no signal reaching it, or listed exited and unreaped though a signal reaches it", async () => {
  const pid = 4_200_160;
  const owner = { pid: 4_200_169, started: MADE_UP };
  for (const [kind, listed] of [
    ["unlisted", new Map<number, SeenProcess>()],
    [
      "zombie",
      new Map<number, SeenProcess>([
        [pid, { exited: true, pgid: pid, started: MADE_UP }],
      ]),
    ],
  ] as const) {
    for (const group of [false, true]) {
      const dir = scratch();
      record(dir, { group, owner, pid, started: MADE_UP });
      const { sent, table } = judged(listed, new Set());
      expect({
        group,
        kind,
        stop: await stopOrphans(dir, { system: table }),
      }).toEqual({ group, kind, stop: { problems: [], stopped: [] } });
      expect(sent).toEqual([]);
      expect({ group, kept: existsSync(recordPath(dir, pid)), kind }).toEqual({
        group,
        kept: false,
        kind,
      });
    }
  }
});

it("does not take an orphan for gone, once signalled, while it is unlisted but a signal still reaches it", async () => {
  const dir = scratch();
  const pid = 4_200_170;
  record(dir, { group: false, owner: OWNER, pid, started: MADE_UP });
  let listed = true;
  const sent: unknown[] = [];
  const table: ProcessTable = {
    // Signalled, it drops out of the listing but still answers.
    alive: (each) => each === pid,
    kill: (...args) => {
      sent.push(args);
      listed = false;
    },
    look: (pids) =>
      new Map(
        listed && pids.includes(pid)
          ? [[pid, { pgid: pid, started: MADE_UP }]]
          : []
      ),
    members: () => new Map(),
    sleep: () => Promise.resolve(),
  };
  const stop = await stopOrphans(dir, { graceMs: 0, killMs: 0, system: table });
  expect(sent).toEqual([[pid, "SIGTERM"]]);
  expect(stop.stopped).toEqual([]);
  expect(stop.problems).toEqual([
    expect.stringContaining("a signal still reaches it"),
  ]);
  expect(existsSync(recordPath(dir, pid))).toBe(true);
});

it("stops a recorded member that still runs as recorded though it left the group, and keeps the record until it is gone", async () => {
  const dir = scratch();
  const leader = 4_200_600;
  const member = 4_200_601;
  record(dir, {
    group: true,
    members: [
      { pid: leader, started: MADE_UP },
      { pid: member, started: MADE_UP },
    ],
    owner: OWNER,
    pid: leader,
    started: MADE_UP,
  });
  // The leader is gone; the member runs, in a group of its own now.
  const { sent, table } = madeUpTable(
    new Map([[member, { pgid: member, started: MADE_UP }]])
  );
  const stop = await stopOrphans(dir, { graceMs: 0, killMs: 0, system: table });
  expect(sent).toEqual([[member, "SIGTERM"]]);
  expect(stop).toEqual({ problems: [], stopped: [leader] });
  expect(existsSync(recordPath(dir, leader))).toBe(false);

  // One that will not stop keeps the record, reported.
  const kept = scratch();
  record(kept, {
    group: true,
    members: [{ pid: member, started: MADE_UP }],
    owner: OWNER,
    pid: leader,
    started: MADE_UP,
  });
  const stubborn = judged(
    new Map([[member, { pgid: member, started: MADE_UP }]]),
    new Set()
  );
  const refused = await stopOrphans(kept, {
    graceMs: 0,
    killMs: 0,
    system: { ...stubborn.table, kill: () => undefined },
  });
  expect(refused.problems).toEqual([expect.stringContaining(String(member))]);
  expect(existsSync(recordPath(kept, leader))).toBe(true);
});

it("takes a group whose leader's pid a new process holds for empty: no member of it can be left", async () => {
  const dir = scratch();
  const leader = 4_200_610;
  record(dir, {
    group: true,
    members: [{ pid: leader, started: MADE_UP }],
    owner: OWNER,
    pid: leader,
    started: MADE_UP,
  });
  const { sent, table } = madeUpTable(
    new Map([[leader, { pgid: leader, started: LATER }]])
  );
  expect(
    await stopOrphans(dir, { graceMs: 0, killMs: 0, system: table })
  ).toEqual({
    problems: [],
    stopped: [],
  });
  expect(sent).toEqual([]);
  expect(existsSync(recordPath(dir, leader))).toBe(false);
});

it("reports, every time, an orphan kept because its owner cannot be told gone or running", async () => {
  for (const [kind, owner] of [
    [
      "a start without its kind",
      { pid: 4_200_620, started: "Sun Nov 15 07:00:00 2026" },
    ],
    ["no start", { pid: 4_200_620, started: null }],
  ] as const) {
    const dir = scratch();
    const child = 4_200_621;
    record(dir, { group: false, owner, pid: child, started: MADE_UP });
    const { sent, table } = madeUpTable(
      new Map([
        // Someone has the owner's pid; the child runs as recorded.
        [owner.pid, { pgid: owner.pid, started: LATER }],
        [child, { pgid: 1, started: MADE_UP }],
      ])
    );
    for (let start = 0; start < 2; start += 1) {
      const stop = await stopOrphans(dir, { system: table });
      expect({ kind, problems: stop.problems }).toEqual({
        kind,
        problems: [expect.stringContaining(`owner ${String(owner.pid)}`)],
      });
    }
    expect(sent).toEqual([]);
    expect(existsSync(recordPath(dir, child))).toBe(true);
  }
});

it("keeps, and reports, a group the listing shows empty while a signal still reaches it", async () => {
  const dir = scratch();
  const leader = 4_200_700;
  record(dir, {
    group: true,
    members: [],
    owner: OWNER,
    pid: leader,
    started: MADE_UP,
  });
  const sent: unknown[] = [];
  const table: ProcessTable = {
    // The group answers a signal; what is in it the listing leaves out.
    alive: (pid) => pid === -leader,
    kill: (...args) => {
      sent.push(args);
    },
    look: () => new Map(),
    members: () => new Map(),
    sleep: () => Promise.resolve(),
  };
  const stop = await stopOrphans(dir, { graceMs: 0, killMs: 0, system: table });
  expect(sent).toEqual([]);
  expect(stop.stopped).toEqual([]);
  expect(stop.problems).toEqual([
    expect.stringContaining(
      `group ${String(leader)} is not listed but a signal still reaches it`
    ),
  ]);
  expect(existsSync(recordPath(dir, leader))).toBe(true);
});
