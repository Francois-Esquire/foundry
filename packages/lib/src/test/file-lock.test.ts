import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireFileLock,
  FileLockTimeoutError,
  processAlive,
  withFileLock,
} from "../file-lock";

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
  if (pid === undefined || processAlive(pid)) {
    throw new Error("could not find an exited pid");
  }
  return pid;
}

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
    await writeFile(lock, String(dead));

    await expect(acquireFileLock(lock, { waitMs: 30 })).rejects.toMatchObject({
      holder: dead,
    });
    const release = await acquireFileLock(lock, { breakStale: true });
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));
    await release();
    expect(await readdir(directory)).toEqual([]);
  });

  it("hands a dead holder's lock to exactly one of many waiting breakers", async () => {
    await writeFile(lock, String(exitedPid()));
    let holding = 0;
    let most = 0;

    await Promise.all(
      Array.from({ length: 12 }, () =>
        withFileLock(
          lock,
          async () => {
            holding += 1;
            most = Math.max(most, holding);
            await new Promise((done) => setTimeout(done, 2));
            holding -= 1;
          },
          { breakStale: true, retryMs: 1 }
        )
      )
    );

    expect(most).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("stops breaking while a breaker's turn file is left behind", async () => {
    await writeFile(lock, String(exitedPid()));
    await writeFile(`${lock}.break`, "");

    await expect(
      acquireFileLock(lock, { breakStale: true, waitMs: 30 })
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it("never breaks a lock that records no holder", async () => {
    await writeFile(lock, "");
    await expect(
      acquireFileLock(lock, { breakStale: true, waitMs: 30 })
    ).rejects.toBeInstanceOf(FileLockTimeoutError);
  });

  it("releases once, and never a lock someone else holds now", async () => {
    const first = await acquireFileLock(lock);
    await first();
    const second = await acquireFileLock(lock);

    await first();
    expect(await readFile(lock, "utf8")).toBe(String(process.pid));

    // Removed by hand and taken by another process meanwhile.
    await writeFile(lock, "999999999");
    await second();
    expect(await readFile(lock, "utf8")).toBe("999999999");
  });

  it("releases after a failed operation", async () => {
    await expect(
      withFileLock(lock, () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom");
    await expect(stat(lock)).rejects.toThrow();
  });
});
