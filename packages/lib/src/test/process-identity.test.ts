import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  compareStarts,
  isGone,
  isProcessIdentity,
  lookProcesses,
  ownerOf,
  procStat,
  psStart,
  sameProcess,
  startedAt,
  thisProcess,
} from "../process-identity";
import { anotherStart } from "../testing/process-identity";

const LONG_AGO = anotherStart();

it("reads this process once, as the system says it started", () => {
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

const LINUX_START = /^linux:[0-9a-f-]{36}:\d+$/;
const PS_START = /^ps:\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}$/;
const BOOT = "6f1c2a7e-2b9d-4c2e-9a51-0d3b7c8e9f10";

it("reads a start under /proc from the ticks since boot and the boot's id, whatever the command is called", () => {
  // Fields 3 on: state, ppid, pgrp (5), session, tty, tpgid, flags, then
  // the fault and time counters, priority, nice, threads, itrealvalue,
  // and starttime (22).
  const rest =
    "S 1 4242 4242 0 -1 4194560 120 0 0 0 3 1 0 0 20 0 1 0 987654 1000 200";
  for (const command of ["sleep", "a b c", "evil) (x", ") ((", "(tricky)"]) {
    expect(procStat(`4243 (${command}) ${rest}`, ` ${BOOT}\n`)).toEqual({
      pgid: 4242,
      started: `linux:${BOOT}:987654`,
    });
  }
  expect(procStat("no parentheses here", BOOT)).toBeUndefined();
  expect(procStat("1 (x) S 1", BOOT)).toBeUndefined();
});

it("compares starts of one kind only: another kind, or none, says nothing", () => {
  const linux = `linux:${BOOT}:987654`;
  expect(compareStarts(linux, `linux:${BOOT}:987654`)).toBe("same");
  expect(compareStarts(linux, `linux:${BOOT}:987655`)).toBe("different");
  // Another boot, the same ticks: another process.
  expect(compareStarts(linux, anotherStart(linux))).toBe("different");
  expect(
    compareStarts(
      psStart("Sun Nov 15  12:00:00 2026"),
      "ps:Sun Nov 15 12:00:00 2026"
    )
  ).toBe("same");
  expect(compareStarts(linux, "ps:Sun Nov 15 12:00:00 2026")).toBe("unknown");
  expect(
    compareStarts("Sun Nov 15 12:00:00 2026", "ps:Sun Nov 15 12:00:00 2026")
  ).toBe("unknown");
  expect(compareStarts(null, linux)).toBe("unknown");
  // A live pid recorded with a start of another kind is never taken for gone.
  expect(
    isGone({ pid: process.pid, started: "Sun Nov 15 12:00:00 2026" })
  ).toBe(false);
});

it.runIf(process.platform === "linux")(
  "reads this process's start from /proc on Linux, as one boot id and its ticks",
  () => {
    const started = thisProcess().started ?? "";
    expect(started).toMatch(LINUX_START);
    expect(lookProcesses([process.pid])?.get(process.pid)?.pgid).toBe(
      Number(
        readFileSync(`/proc/${String(process.pid)}/stat`, "utf8")
          .slice(
            readFileSync(
              `/proc/${String(process.pid)}/stat`,
              "utf8"
            ).lastIndexOf(")") + 1
          )
          .trim()
          .split(" ")[2]
      )
    );
  }
);

it.runIf(process.platform !== "linux")(
  "reads a start from ps elsewhere",
  () => {
    expect(thisProcess().started ?? "").toMatch(PS_START);
  }
);
