import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  execFileRecorded,
  notPrivate,
  recordSpawned,
  SPAWN_OWNER_ENV,
  SPAWN_RECORD_ENV,
  startedAt,
} from "../spawn-record";

const made: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A private scratch directory of this test's. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-record-"));
  made.push(dir);
  return dir;
}

it("does nothing when no directory is named", () => {
  const spawned = vi.spyOn(process.stderr, "write");
  recordSpawned(process.pid, false, {});
  expect(spawned).not.toHaveBeenCalled();
});

it("writes a private record of the process, making the directory private if it is missing", () => {
  const dir = join(scratch(), "a", "b");
  recordSpawned(process.pid, true, { [SPAWN_RECORD_ENV]: dir });
  const path = join(dir, `${String(process.pid)}.json`);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    group: true,
    pid: process.pid,
    started: startedAt(process.pid),
  });
  expect(notPrivate(dir, "directory")).toBeUndefined();
  expect(notPrivate(path, "file")).toBeUndefined();
  // Nothing in flight is left behind.
  expect(readdirSync(dir)).toEqual([`${String(process.pid)}.json`]);
});

it("refuses a directory open to others, and a path that is not a directory, without throwing", () => {
  const shared = join(scratch(), "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o755);
  const file = join(scratch(), "file");
  writeFileSync(file, "a file");
  const said = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(() =>
    recordSpawned(process.pid, false, { [SPAWN_RECORD_ENV]: shared })
  ).not.toThrow();
  expect(() =>
    recordSpawned(process.pid, false, { [SPAWN_RECORD_ENV]: file })
  ).not.toThrow();
  expect(readdirSync(shared)).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("a file");
  // Said once for the process, not once per spawn.
  expect(said.mock.calls.length).toBeLessThanOrEqual(1);
});

it("never writes through a link planted where the record goes", () => {
  const dir = scratch();
  const victim = join(scratch(), "victim");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, join(dir, `${String(process.pid)}.json`));
  symlinkSync(victim, join(dir, `${String(process.pid)}.json.new`));
  recordSpawned(process.pid, false, { [SPAWN_RECORD_ENV]: dir });
  expect(readFileSync(victim, "utf8")).toBe("untouched");
  const path = join(dir, `${String(process.pid)}.json`);
  expect(lstatSync(path).isFile()).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
});

it("records what it runs, and carries the recorder's variables into the environment it is given", async () => {
  const dir = scratch();
  vi.stubEnv(SPAWN_RECORD_ENV, dir);
  vi.stubEnv(SPAWN_OWNER_ENV, `owner ${dir}`);
  const { stdout } = await execFileRecorded(
    process.execPath,
    ["-e", `console.log(process.pid, process.env.${SPAWN_OWNER_ENV})`],
    { env: { PATH: process.env.PATH ?? "" } }
  );
  const [pid, owner] = stdout.trim().split(" ", 2);
  expect(owner).toBe("owner");
  expect(readdirSync(dir)).toEqual([`${pid}.json`]);
});

it("records nothing for a child that has already gone", async () => {
  const dir = scratch();
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((settle) => child.once("exit", settle));
  // Reaped by now, so no process has its pid.
  recordSpawned(child.pid, false, { [SPAWN_RECORD_ENV]: dir });
  expect(readdirSync(dir)).toEqual([]);
});
