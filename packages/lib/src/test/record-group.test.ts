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
import { startedAt } from "../process-identity";
import { recordGroup, recordPath, SPAWN_RECOVERY_ENV } from "../spawn-record";

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

it("keeps the record of a group that would not empty, for the next start", async () => {
  const signalled: (NodeJS.Signals | 0)[] = [];
  const { child, dir, stop } = await group("wait", (spawned, at) =>
    recordGroup(spawned, {
      env: { [SPAWN_RECOVERY_ENV]: join(at, "records") },
      graceMs: 30,
      killMs: 30,
      // A system whose group never empties, whatever it is sent.
      system: {
        kill: (_target, signal) => {
          signalled.push(signal);
        },
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      },
    })
  );
  expect(await stop()).toBe(false);
  expect(signalled).toContain("SIGTERM");
  expect(signalled).toContain("SIGKILL");
  expect(records(dir)).toEqual([`${String(child.pid)}.json`]);
  expect(existsSync(recordPath(join(dir, "records"), child.pid ?? 0))).toBe(
    true
  );
  // Stopped for real here, as the next start would.
  process.kill(-(child.pid ?? 0), "SIGKILL");
});
