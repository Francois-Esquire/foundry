import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import {
  isGone,
  isProcessIdentity,
  ownerOf,
  sameProcess,
  startedAt,
  thisProcess,
} from "../process-identity";

const LONG_AGO = "Thu Jan  1 00:00:00 1970";

it("reads this process once, with its start time as ps prints it", () => {
  const self = thisProcess();
  expect(self).toEqual({ pid: process.pid, started: startedAt(process.pid) });
  expect(thisProcess()).toBe(self);
  expect(isGone(self)).toBe(false);
});

it("takes an earlier process with this one's pid, as after a reboot, for gone", () => {
  expect(isGone({ pid: process.pid, started: LONG_AGO })).toBe(true);
  // One recorded with no start time is taken by its pid alone.
  expect(isGone({ pid: process.pid, started: null })).toBe(false);
});

it("takes a live pid that started at another time for gone, and one that exited", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const pid = child.pid ?? 0;
    const started = startedAt(pid);
    expect(typeof started).toBe("string");
    expect(isGone({ pid, started: started ?? null })).toBe(false);
    // Spaced differently, as ps pads a one-digit day: the same start.
    expect(
      isGone({ pid, started: ` ${String(started)}`.replace(" ", "  ") })
    ).toBe(false);
    expect(isGone({ pid, started: LONG_AGO })).toBe(true);
    expect(isGone({ pid, started: null })).toBe(false);
  } finally {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGKILL");
    await exited;
  }
  expect(isGone({ pid: child.pid ?? 0, started: null })).toBe(true);
});

it("compares identities as far as each says, and reads them back from columns and JSON", () => {
  const self = thisProcess();
  expect(sameProcess(self, { ...self })).toBe(true);
  expect(sameProcess(self, { pid: self.pid, started: null })).toBe(true);
  expect(sameProcess(self, { pid: self.pid, started: LONG_AGO })).toBe(false);
  expect(sameProcess(self, { pid: self.pid + 1, started: self.started })).toBe(
    false
  );
  expect(ownerOf(null, null)).toBeNull();
  expect(ownerOf(7, "x")).toEqual({ pid: 7, started: "x" });
  expect(isProcessIdentity({ pid: 7, started: null })).toBe(true);
  expect(isProcessIdentity({ pid: 7 })).toBe(false);
  expect(isProcessIdentity({ pid: 0, started: "x" })).toBe(false);
});
