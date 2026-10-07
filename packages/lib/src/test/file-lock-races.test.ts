import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { acquireFileLock, processAlive } from "../file-lock";

/** Faults injected into the lock's own file operations. */
const faults = vi.hoisted(() => ({
  /** The next handle opened fails to write. */
  failWrite: false,
  /** The next removal of this path is held back this long. */
  slowRemoval: undefined as { path: string; ms: number } | undefined,
}));

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!faults.failWrite) {
        return handle;
      }
      faults.failWrite = false;
      return {
        close: () => handle.close(),
        writeFile: () => Promise.reject(new Error("disk full")),
      };
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const slow = faults.slowRemoval;
      if (slow && args[0] === slow.path) {
        faults.slowRemoval = undefined;
        await new Promise((done) => setTimeout(done, slow.ms));
      }
      return actual.rm(...args);
    },
  };
});

let directory: string;
let lock: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lib-file-lock-"));
  lock = join(directory, "state.lock");
});

afterEach(async () => {
  faults.failWrite = false;
  faults.slowRemoval = undefined;
  await rm(directory, { force: true, recursive: true });
});

it("removes a lock whose holder could not be recorded, so it cannot wedge", async () => {
  faults.failWrite = true;
  await expect(acquireFileLock(lock)).rejects.toThrow("disk full");
  expect(await readdir(directory)).toEqual([]);

  const release = await acquireFileLock(lock, { waitMs: 30 });
  await release();
});

it("does not let a slow breaker remove the lock another breaker took", async () => {
  const { pid: dead } = spawnSync(process.execPath, ["-e", ""]);
  if (dead === undefined || processAlive(dead)) {
    throw new Error("could not find an exited pid");
  }
  await writeFile(lock, String(dead));
  // The first breaker to remove the stale lock is slow about it. Without
  // turns, the second removes it too, takes the lock, and then loses it to
  // the first breaker's late removal: both would hold the lock.
  faults.slowRemoval = { ms: 40, path: lock };
  let holding = 0;
  let most = 0;
  const hold = async () => {
    const release = await acquireFileLock(lock, {
      breakStale: true,
      retryMs: 1,
    });
    holding += 1;
    most = Math.max(most, holding);
    await new Promise((done) => setTimeout(done, 80));
    holding -= 1;
    await release();
  };

  await Promise.all([hold(), hold()]);

  expect(most).toBe(1);
  expect(await readdir(directory)).toEqual([]);
});
