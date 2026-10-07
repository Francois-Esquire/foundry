import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireFileLock,
  FileLockTimeoutError,
  processAlive,
  withFileLock,
} from "../file-lock";
import { KeyedQueue } from "../keyed-queue";

let directory: string;
let lock: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lib-file-lock-"));
  lock = join(directory, "state.lock");
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

/** A pid that was running a moment ago and is not now. */
function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("could not start a process");
  }
  return pid;
}

describe("KeyedQueue", () => {
  it("runs one key's operations in call order, other keys alongside", async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();

    const first = queue.run("a", async () => {
      await gate;
      order.push("a1");
    });
    const second = queue.run("a", () => {
      order.push("a2");
      return Promise.resolve();
    });
    await queue.run("b", () => {
      order.push("b1");
      return Promise.resolve();
    });
    open();
    await Promise.all([first, second]);

    expect(order).toEqual(["b1", "a1", "a2"]);
  });

  it("keeps going after a failed operation", async () => {
    const queue = new KeyedQueue();
    const failed = queue.run("a", () => Promise.reject(new Error("boom")));
    const next = queue.run("a", () => Promise.resolve("ran"));

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ran");
  });
});

describe("file locks", () => {
  it("records the holder and removes the file on release", async () => {
    const release = await acquireFileLock(lock);
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    // biome-ignore lint/suspicious/noBitwiseOperators: Mask file type bits to check private POSIX permissions.
    expect((await stat(lock)).mode & 0o777).toBe(0o600);
    await release();
    await expect(stat(lock)).rejects.toThrow();
  });

  it("waits for the holder to release", async () => {
    const release = await acquireFileLock(lock);
    const order: string[] = [];
    const waiting = withFileLock(lock, () => {
      order.push("second");
      return Promise.resolve();
    });
    await new Promise((done) => setTimeout(done, 30));
    order.push("first released");
    await release();
    await waiting;

    expect(order).toEqual(["first released", "second"]);
  });

  it("gives up on a live holder and names it", async () => {
    await writeFile(lock, String(process.pid));
    const error = await acquireFileLock(lock, {
      breakStale: true,
      waitMs: 30,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FileLockTimeoutError);
    expect(error).toMatchObject({ holder: process.pid, path: lock });
  });

  it("breaks a dead holder's lock only when asked", async () => {
    const dead = exitedPid();
    expect(processAlive(dead)).toBe(false);
    await writeFile(lock, String(dead));

    await expect(acquireFileLock(lock, { waitMs: 30 })).rejects.toMatchObject({
      holder: dead,
    });
    const release = await acquireFileLock(lock, { breakStale: true });
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    await release();
  });

  it("never breaks a lock that records no holder", async () => {
    await writeFile(lock, "");
    await expect(
      acquireFileLock(lock, { breakStale: true, waitMs: 30 })
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it("releases after a failed operation", async () => {
    await expect(
      withFileLock(lock, () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
    await expect(stat(lock)).rejects.toThrow();
  });
});
