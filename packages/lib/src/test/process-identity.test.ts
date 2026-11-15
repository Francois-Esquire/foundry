import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const SRC = resolve(import.meta.dirname, "..");
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

it.skipIf(process.platform === "linux")(
  "never takes a start it read a moment ago as proof that a pid's new process is gone",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-cache-"));
    // A process of this test's, whose pid `ps` is then made to report as
    // started at another time: as if it were handed to a new process.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const pid = child.pid ?? 0;
      const seen = join(dir, "seen");
      writeFileSync(seen, "Sun Nov 15 12:00:00 2026");
      writeFileSync(
        join(dir, "ps"),
        `#!/bin/sh\nif [ "$4" = "${String(pid)}" ]; then printf '${String(pid)} ${String(pid)} '; cat '${seen}'; else exec /bin/ps "$@"; fi\n`,
        { mode: 0o700 }
      );
      const script = join(dir, "check.ts");
      writeFileSync(
        script,
        `const { isGone } = await import(${JSON.stringify(join(SRC, "process-identity.ts"))});
const { writeFileSync } = await import("node:fs");
const before = isGone({ pid: ${String(pid)}, started: "ps:Sun Nov 15 12:00:00 2026" });
writeFileSync(${JSON.stringify(seen)}, "Sun Nov 15 12:01:00 2026");
// Within the second the first read is kept: the new holder is still there.
const after = isGone({ pid: ${String(pid)}, started: "ps:Sun Nov 15 12:01:00 2026" });
const former = isGone({ pid: ${String(pid)}, started: "ps:Sun Nov 15 12:00:00 2026" });
console.log(JSON.stringify({ after, before, former }));`
      );
      const output = execFileSync("bun", [script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      });
      expect(JSON.parse(output.trim())).toEqual({
        after: false,
        before: false,
        former: true,
      });
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { force: true, recursive: true });
    }
  }
);
