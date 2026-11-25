import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { acquireFileLock, lockContents, tryFileLock } from "../node/file-lock";
import { processAlive } from "../node/process-identity";

const faults = vi.hoisted(() => ({
  beforeRead: undefined as
    | { readonly path: string; nth: number; readonly run: () => void }
    | undefined,
  beforeRemoval: undefined as
    | { readonly path: string; readonly run: () => void }
    | undefined,
  failWrite: false,
}));

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const hook = faults.beforeRead;
      if (hook && args[0] === hook.path) {
        hook.nth -= 1;
        if (hook.nth === 0) {
          faults.beforeRead = undefined;
          hook.run();
        }
      }
      return actual.readFileSync(...args);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const hook = faults.beforeRemoval;
      if (hook && args[0] === hook.path) {
        faults.beforeRemoval = undefined;
        hook.run();
      }
      actual.rmSync(...args);
    },
    writeSync: (...args: Parameters<typeof actual.writeSync>) => {
      if (faults.failWrite) {
        faults.failWrite = false;
        throw new Error("disk full");
      }
      return actual.writeSync(...args);
    },
  };
});

function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined || processAlive(pid)) {
    throw new Error("could not find an exited pid");
  }
  return pid;
}

let directory: string;
let lock: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lib-file-lock-"));
  lock = join(directory, "state.lock");
});

afterEach(async () => {
  faults.failWrite = false;
  faults.beforeRead = undefined;
  faults.beforeRemoval = undefined;
  await rm(directory, { force: true, recursive: true });
});

it("removes a lock whose holder could not be recorded, so it cannot wedge", async () => {
  faults.failWrite = true;
  await expect(acquireFileLock(lock)).rejects.toThrow("disk full");
  expect(await readdir(directory)).toEqual([]);

  const release = await acquireFileLock(lock, { waitMs: 30 });
  await release();
});

it("does not let a breaker remove the lock another breaker took", async () => {
  const dead = exitedPid();
  await writeFile(lock, String(dead));
  let other: ReturnType<typeof tryFileLock> | undefined;
  faults.beforeRemoval = {
    path: lock,
    run: () => {
      other = tryFileLock(lock, { breakStale: true });
    },
  };

  const attempt = tryFileLock(lock, { breakStale: true });

  expect(other).toMatchObject({ holder: dead });
  expect("release" in attempt).toBe(true);
  if ("release" in attempt) {
    attempt.release();
  }
  expect(await readdir(directory)).toEqual([]);
});

it("takes a lock released between its attempt and the read of its holder", async () => {
  await writeFile(lock, String(process.pid));
  faults.beforeRead = {
    nth: 1,
    path: lock,
    run: () => {
      rmSync(lock);
    },
  };

  const attempt = tryFileLock(lock);

  expect(attempt).toHaveProperty("release");
  expect(await readFile(lock, "utf8")).toBe(lockContents());
});

it("leaves a lock alone that changed hands before its breaker's turn came", async () => {
  const dead = exitedPid();
  await writeFile(lock, String(dead));
  const other = process.ppid;
  faults.beforeRead = {
    nth: 2,
    path: lock,
    run: () => {
      writeFileSync(lock, String(other));
    },
  };

  expect(tryFileLock(lock, { breakStale: true })).toMatchObject({
    holder: other,
  });
  expect(await readFile(lock, "utf8")).toBe(String(other));
});
