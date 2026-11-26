import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nodeStartedAt } from "../node/process-identity";
import {
  execFileRecorded,
  forgetRecord,
  notPrivate,
  type RecordFiles,
  recordChild,
  recordPath,
  recordSpawned,
  SPAWN_OWNER_ENV,
  SPAWN_RECORD_ENV,
  spawnRecordEnvironment,
  writePrivate,
} from "../node/spawn-record";

const made: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-record-"));
  made.push(dir);
  return dir;
}

it("does nothing when no directory is named", () => {
  const spawned = vi.spyOn(process.stderr, "write");
  recordSpawned(process.pid, false, { env: {}, recovery: false });
  expect(spawned).not.toHaveBeenCalled();
});

it("writes a private record of the process, making the directory private if it is missing", () => {
  const dir = join(scratch(), "a", "b");
  recordSpawned(process.pid, true, {
    env: { [SPAWN_RECORD_ENV]: dir },
    recovery: false,
  });
  const path = join(dir, `${String(process.pid)}.json`);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    group: true,
    pid: process.pid,
    started: nodeStartedAt(process.pid),
  });
  expect(notPrivate(dir, "directory")).toBeUndefined();
  expect(notPrivate(path, "file")).toBeUndefined();
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
    recordSpawned(process.pid, false, {
      env: { [SPAWN_RECORD_ENV]: shared },
      recovery: false,
    })
  ).not.toThrow();
  expect(() =>
    recordSpawned(process.pid, false, {
      env: { [SPAWN_RECORD_ENV]: file },
      recovery: false,
    })
  ).not.toThrow();
  expect(readdirSync(shared)).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("a file");
  expect(said.mock.calls.length).toBeLessThanOrEqual(1);
});

it("never writes through a link planted where the record goes", () => {
  const dir = scratch();
  const victim = join(scratch(), "victim");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, join(dir, `${String(process.pid)}.json`));
  symlinkSync(victim, join(dir, `${String(process.pid)}.json.new`));
  recordSpawned(process.pid, false, {
    env: { [SPAWN_RECORD_ENV]: dir },
    recovery: false,
  });
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
  recordSpawned(child.pid, false, {
    env: { [SPAWN_RECORD_ENV]: dir },
    recovery: false,
  });
  expect(readdirSync(dir)).toEqual([]);
});

const PID = 4_200_090;
const GONE = { group: false, pid: PID, started: "ps:Sun Nov 15 08:00:00 2026" };
const SINCE = { ...GONE, started: "ps:Sun Nov 15 09:00:00 2026" };
const NEWER = { ...GONE, started: "ps:Sun Nov 15 10:00:00 2026" };

function recoveryRoot(): string {
  const root = scratch();
  vi.stubEnv("FOUNDRY_ROOT", root);
  return join(root, "processes");
}

function startsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).started)
    .sort();
}

function hooked(before: (index: number) => void): RecordFiles {
  let index = 0;
  const step = <T>(work: () => T): T => {
    before(index);
    index += 1;
    return work();
  };
  return {
    link: (existing, path) => step(() => linkSync(existing, path)),
    read: (path) => step(() => readFileSync(path, "utf8")),
    remove: (path) => step(() => rmSync(path, { force: true })),
    rename: (from, to) => step(() => renameSync(from, to)),
  };
}

it("forgets a record only if what it removes names the process that is gone, wherever another's write lands", () => {
  let tried = 0;
  for (let at = 0; ; at += 1) {
    const dir = scratch();
    const path = recordPath(dir, PID);
    writePrivate(path, JSON.stringify(GONE));
    let landed = false;
    forgetRecord(
      path,
      GONE,
      hooked((index) => {
        if (index === at) {
          writePrivate(path, JSON.stringify(SINCE));
          landed = true;
        }
      })
    );
    if (!landed) {
      break;
    }
    tried += 1;
    expect({ at, starts: startsIn(dir) }).toEqual({
      at,
      starts: [SINCE.started],
    });
  }
  expect(tried).toBe(3);

  const dir = scratch();
  const path = recordPath(dir, PID);
  writePrivate(path, JSON.stringify(SINCE));
  forgetRecord(
    path,
    GONE,
    hooked((index) => {
      if (index === 2) {
        writePrivate(path, JSON.stringify(NEWER));
      }
    })
  );
  expect(startsIn(dir)).toEqual([SINCE.started, NEWER.started]);
  expect(JSON.parse(readFileSync(path, "utf8")).started).toBe(NEWER.started);

  const plain = scratch();
  writePrivate(recordPath(plain, PID), JSON.stringify(GONE));
  forgetRecord(recordPath(plain, PID), GONE);
  expect(readdirSync(plain)).toEqual([]);
});

it("keeps, as a child exits, a recovery record that names another process", async () => {
  const dir = recoveryRoot();
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  recordChild(child);
  const path = recordPath(dir, child.pid ?? 0);
  const other = {
    ...JSON.parse(readFileSync(path, "utf8")),
    started: NEWER.started,
  };
  writePrivate(path, JSON.stringify(other));
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGKILL");
  await exited;
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8")).started).toBe(NEWER.started);
});

it("reports, and keeps, the recovery record of an exited child it cannot remove", async () => {
  const dir = recoveryRoot();
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  recordChild(child);
  const path = recordPath(dir, child.pid ?? 0);
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  chmodSync(dir, 0o500);
  try {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(existsSync(path)).toBe(true);
  expect(stderr.mock.calls.flat().join("")).toContain(
    `could not remove the recovery record ${path}`
  );
});

it("reports, and writes no record of, a process the listing leaves out while a signal still reaches it", async () => {
  vi.resetModules();
  const fresh = await import("../node/spawn-record");
  const dir = scratch();
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  let written = "";
  try {
    fresh.recordSpawned(4_200_190, false, {
      env: { [SPAWN_RECORD_ENV]: dir },
      lookup: { alive: () => true, look: () => new Map() },
      recovery: false,
    });
  } finally {
    written = stderr.mock.calls.flat().join("");
    stderr.mockRestore();
  }
  expect(readdirSync(dir)).toEqual([]);
  expect(written).toContain("not listed, yet a signal reaches it");
});

it("records for recovery under the root its environment names", () => {
  const root = scratch();
  recordSpawned(process.pid, false, {
    env: { FOUNDRY_ROOT: `${root}/`, VITEST: "true" },
  });
  const path = recordPath(join(root, "processes"), process.pid);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    owner: { pid: process.pid },
    pid: process.pid,
  });
});

it("records nothing for recovery when told not to, or under a test runner with no root", () => {
  const root = scratch();
  recordSpawned(process.pid, false, {
    env: { FOUNDRY_ROOT: root },
    recovery: false,
  });
  expect(readdirSync(root)).toEqual([]);
  const lookup = vi.fn(() => new Map());
  recordSpawned(process.pid, false, {
    env: { VITEST: "true" },
    lookup: { alive: () => true, look: lookup },
  });
  expect(lookup).not.toHaveBeenCalled();
});

it("records under the user's Foundry directory outside a test runner", async () => {
  vi.resetModules();
  const home = scratch();
  vi.stubEnv("HOME", home);
  const fresh = await import("../node/spawn-record");
  fresh.recordSpawned(process.pid, false, { env: {} });
  expect(readdirSync(join(home, ".foundry", "processes"))).toEqual([
    `${String(process.pid)}.json`,
  ]);
});

it("carries the Foundry root into a filtered child environment", () => {
  expect(
    spawnRecordEnvironment({ FOUNDRY_ROOT: "/srv/foundry", PATH: "/bin" })
  ).toEqual({ FOUNDRY_ROOT: "/srv/foundry" });
  expect(spawnRecordEnvironment({ FOUNDRY_ROOT: "" })).toEqual({});
});
