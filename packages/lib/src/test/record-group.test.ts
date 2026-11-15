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
  type SeenProcess,
  startedAt,
  thisProcess,
} from "../process-identity";
import {
  type GroupSystem,
  recordGroup,
  recordPath,
  SPAWN_RECOVERY_ENV,
  type SpawnRecord,
} from "../spawn-record";

/**
 * A group leader recorded as a group is stopped with everything it
 * started. Every process here is this test's own: a shell it starts,
 * leading a group, and the `sleep` that shell starts in it, which the
 * test stops by its pid, proved by its start, if a test leaves it.
 */

const made: string[] = [];
const leftovers: { pid: number; started: string }[] = [];

afterEach(() => {
  for (const { pid, started } of leftovers.splice(0)) {
    if (startedAt(pid) === started) {
      process.kill(pid, "SIGKILL");
    }
  }
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * A shell leading a group of its own, which starts a `sleep` in it, then
 * runs `then`; `record` is handed it in the same turn as the spawn, as a
 * caller records its child.
 */
async function group(
  then: string,
  record: (child: ChildProcess, dir: string) => () => Promise<boolean>
): Promise<{
  readonly child: ChildProcess;
  readonly dir: string;
  readonly sleep: number;
  readonly stop: () => Promise<boolean>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "record-group-"));
  made.push(dir);
  const child = spawn(
    "/bin/sh",
    ["-c", `sleep 60 & echo $! > '${dir}/pid'; ${then}`],
    { detached: true, stdio: "ignore" }
  );
  const stop = record(child, dir);
  for (let i = 0; i < 500 && !existsSync(join(dir, "pid")); i += 1) {
    await new Promise((done) => setTimeout(done, 10));
  }
  const sleep = Number(readFileSync(join(dir, "pid"), "utf8").trim());
  const started = startedAt(sleep);
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
    if (startedAt(pid) === null) {
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
  expect(await stop()).toBe(true);
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
  expect(await stop()).toBe(true);
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
      // A system whose group never empties, whatever it is sent: no
      // signal is sent for real; its members are read for real.
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
  expect(await stop()).toBe(false);
  // What a start after this process died mid-stop proves each member by.
  expect(recordedAtTerm?.members).toEqual(
    expect.arrayContaining([
      { pid: child.pid, started: startedAt(child.pid ?? 0) },
      { pid: sleep, started: startedAt(sleep) },
    ])
  );
  expect(recordedAtTerm?.owner).toEqual(thisProcess());
  expect(signalled).toContain("SIGTERM");
  expect(signalled).toContain("SIGKILL");
  expect(records(dir)).toEqual([`${String(child.pid)}.json`]);
  expect(existsSync(recordPath(join(dir, "records"), child.pid ?? 0))).toBe(
    true
  );
  // Stopped for real here, as the next start would.
  process.kill(-(child.pid ?? 0), "SIGKILL");
});

/**
 * A made-up child, leading a made-up group: its pid is above any
 * system's limit, and no signal reaches a real process. `exit` reaps it.
 */
function madeUpChild(pid: number): {
  readonly child: Pick<ChildProcess, "once" | "pid">;
  readonly exit: () => void;
} {
  let onExit: (() => void) | undefined;
  return {
    child: {
      once(event: string, listener: () => void) {
        if (event === "exit") {
          onExit = listener;
        }
        return this;
      },
      pid,
    } as Pick<ChildProcess, "once" | "pid">,
    exit: () => onExit?.(),
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
  const system: GroupSystem = {
    kill(target, signal) {
      sent.push([target, signal]);
      if (signal === "SIGTERM") {
        // The group empties, and its id goes to another group.
        members = new Map([[4_200_042, { pgid, started: LATER }]]);
      }
    },
    members: () => members,
    sleep: () => Promise.resolve(),
  };
  const stop = recordGroup(child, { env: {}, graceMs: 0, killMs: 0, system });
  exit();
  expect(await stop()).toBe(false);
  expect(sent.filter(([, signal]) => signal !== 0)).toEqual([
    [-pgid, "SIGTERM"],
  ]);
});

it("takes a group left only with exited, unreaped members (zombies) for empty", async () => {
  const pgid = 4_200_050;
  const { child, exit } = madeUpChild(pgid);
  const sent: [number, NodeJS.Signals | 0][] = [];
  const system: GroupSystem = {
    kill(target, signal) {
      sent.push([target, signal]);
      // A group of exited members not yet reaped answers EPERM on macOS.
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    },
    members: () =>
      new Map([[4_200_051, { exited: true, pgid, started: MADE_UP }]]),
    sleep: () => Promise.resolve(),
  };
  const stop = recordGroup(child, { env: {}, system });
  exit();
  expect(await stop()).toBe(true);
  expect(sent).toEqual([[-pgid, 0]]);
});

it("sends nothing to a group id another process leads once the leader is reaped: it was emptied before", async () => {
  const pgid = 4_200_060;
  const { child, exit } = madeUpChild(pgid);
  const sent: [number, NodeJS.Signals | 0][] = [];
  const system: GroupSystem = {
    kill(target, signal) {
      sent.push([target, signal]);
    },
    // A process with the leader's pid leads the group: not the leader,
    // which was reaped.
    members: () =>
      new Map([
        [pgid, { pgid, started: LATER }],
        [4_200_061, { pgid, started: LATER }],
      ]),
    sleep: () => Promise.resolve(),
  };
  const stop = recordGroup(child, { env: {}, system });
  exit();
  expect(await stop()).toBe(true);
  expect(sent).toEqual([[-pgid, 0]]);
});
