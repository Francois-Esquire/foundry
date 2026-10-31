import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeJson } from "~/lib/state/json";
import {
  claimProcess,
  ProcessHeldError,
  readProcess,
} from "~/process/instance";

function stateDir() {
  return mkdtempSync(join(tmpdir(), "marbles-process-"));
}

/** A pid that is certainly not running. */
function deadPid(): number {
  return spawnSync("true").pid;
}

describe("claimProcess", () => {
  it("claims the workspace, records itself, and releases both files", () => {
    const dir = stateDir();
    const claim = claimProcess(dir, {
      config: "/repo/.foundry/marbles",
      host: "worker",
    });
    expect(claim.pid).toBe(process.pid);
    expect(readFileSync(join(dir, "locks", "process"), "utf8")).toBe(
      String(process.pid)
    );
    expect(readProcess(dir)).toEqual({
      alive: true,
      artifacts: null,
      config: "/repo/.foundry/marbles",
      host: "worker",
      pid: process.pid,
      socket: null,
      startedAt: claim.startedAt,
      version: null,
    });
    claim.release();
    claim.release();
    expect(existsSync(join(dir, "locks", "process"))).toBe(false);
    expect(existsSync(join(dir, "process.json"))).toBe(false);
    expect(readProcess(dir)).toBeUndefined();
  });

  it("refuses a second claim and names the holder", () => {
    const dir = stateDir();
    const first = claimProcess(dir, { config: null, host: "daemon" });
    try {
      expect(() => claimProcess(dir, { config: null, host: "worker" })).toThrow(
        ProcessHeldError
      );
      expect(() => claimProcess(dir, { config: null, host: "worker" })).toThrow(
        `pid ${process.pid} (daemon) since ${first.startedAt}`
      );
    } finally {
      first.release();
    }
    expect(claimProcess(dir, { config: null, host: "worker" }).host).toBe(
      "worker"
    );
  });

  it("takes over a claim whose process has exited", () => {
    const dir = stateDir();
    const dead = deadPid();
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(join(dir, "locks", "process"), String(dead));
    writeJson(join(dir, "process.json"), {
      config: null,
      host: "worker",
      pid: dead,
      startedAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    });
    expect(readProcess(dir)).toMatchObject({
      alive: false,
      host: "worker",
      pid: dead,
    });
    const claim = claimProcess(dir, { config: null, host: "worker" });
    expect(readProcess(dir)).toMatchObject({
      alive: true,
      host: "worker",
      pid: process.pid,
    });
    claim.release();
  });

  it("leaves a claim another process took over alone when released late", () => {
    const dir = stateDir();
    const claim = claimProcess(dir, { config: null, host: "worker" });
    // Simulate a takeover: the files now describe someone else.
    rmSync(join(dir, "locks", "process"));
    writeFileSync(join(dir, "locks", "process"), "999999");
    writeJson(join(dir, "process.json"), {
      config: null,
      host: "worker",
      pid: 999_999,
      startedAt: "x",
      version: 1,
    });
    claim.release();
    expect(readFileSync(join(dir, "locks", "process"), "utf8")).toBe("999999");
    expect(existsSync(join(dir, "process.json"))).toBe(true);
  });
});

describe("readProcess", () => {
  it("decides liveness from the lock, and trusts metadata only for the holder", () => {
    const dir = stateDir();
    mkdirSync(join(dir, "locks"), { recursive: true });
    writeFileSync(join(dir, "locks", "process"), String(process.pid));
    expect(readProcess(dir)).toEqual({
      alive: true,
      artifacts: null,
      config: null,
      host: null,
      pid: process.pid,
      socket: null,
      startedAt: null,
      version: null,
    });
    // Stale metadata from an earlier owner does not describe this one.
    writeJson(join(dir, "process.json"), {
      config: "/old",
      host: "daemon",
      pid: deadPid(),
      startedAt: "x",
      version: 1,
    });
    expect(readProcess(dir)).toMatchObject({
      alive: true,
      host: null,
      pid: process.pid,
    });
    // Metadata alone, no lock: known but not alive.
    rmSync(join(dir, "locks", "process"));
    expect(readProcess(dir)).toMatchObject({ alive: false, host: "daemon" });
  });
});
