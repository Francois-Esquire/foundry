import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A record of a process Marbles started in the background, for whoever
 * has to find it again after the process that started it is gone: today
 * the test suite, which names a directory in `MARBLES_SPAWN_RECORD` and
 * stops what it finds there when a test or a run ends. Unset, nothing is
 * recorded and nothing runs. The daemon records each worker it spawns,
 * a client the daemon it starts, and `marbles mcp` the server it relays.
 *
 * A record names the process by pid and the time it started, as the
 * system reports it, so a later reader can tell it from another process
 * that has been given the same pid since.
 */
export interface SpawnRecord {
  /** It leads a process group of its own, whose id is its pid. */
  readonly group: boolean;
  readonly pid: number;
  /** As `startedAt` reads it. */
  readonly started: string;
}

export const SPAWN_RECORD_ENV = "MARBLES_SPAWN_RECORD";

/** `ps` prints a start time in its caller's zone and language: one for every caller. */
const PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

/**
 * When the process `pid` started, as `ps -o lstart=` prints it in UTC;
 * `null` when no process has the pid, `undefined` when `ps` cannot tell.
 */
export function startedAt(pid: number): string | null | undefined {
  const listed = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: PS_ENV,
  });
  const started = listed.stdout?.trim();
  if (listed.status === 0 && started) {
    return started;
  }
  // `ps` exits 1, printing nothing, when no process has the pid.
  return listed.error === undefined && listed.status === 1 && !started
    ? null
    : undefined;
}

/**
 * Record `pid`, which this process has just started, in the directory
 * `env` names, if it names one. Call it in the same turn as the spawn:
 * until this process reaps the child, which waits for its event loop, no
 * other process can be given that pid. Written whole, so a reader never
 * finds half a record.
 */
export function recordSpawned(
  pid: number | undefined,
  group: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  const dir = env[SPAWN_RECORD_ENV];
  if (dir === undefined || dir === "" || pid === undefined) {
    return;
  }
  const started = startedAt(pid);
  if (started === null) {
    return;
  }
  if (started === undefined) {
    throw new Error(`could not read when process ${String(pid)} started`);
  }
  const record: SpawnRecord = { group, pid, started };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${String(pid)}.json`);
  writeFileSync(`${path}.new`, JSON.stringify(record));
  renameSync(`${path}.new`, path);
}
