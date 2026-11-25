import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  compareStarts,
  groupIdTaken,
  isGone,
  isProcessIdentity,
  lookProcesses,
  ownerOf,
  type ProcessLookup,
  processState,
  procListing,
  procStat,
  psLine,
  psListing,
  psStart,
  type SeenProcess,
  sameProcess,
  startedAt,
  thisProcess,
} from "../node/process-identity";
import { startedAt as pureStartedAt } from "../process-identity";
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
  expect(isGone({ pid: process.pid, started: null })).toBe(false);
});

it("takes a live pid that started at another time for gone, and one that exited", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const pid = child.pid ?? 0;
    const started = startedAt(pid);
    expect(typeof started).toBe("string");
    expect(isGone({ pid, started: started ?? null })).toBe(false);
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

it("reads whether a process has exited and waits to be reaped (a zombie), under /proc and from ps", () => {
  const rest =
    "1 4242 4242 0 -1 4194560 120 0 0 0 3 1 0 0 20 0 1 0 987654 1000 200";
  expect(procStat(`4243 (sleep) Z ${rest}`, BOOT)).toEqual({
    exited: true,
    pgid: 4242,
    started: `linux:${BOOT}:987654`,
  });
  expect(procStat(`4243 (sleep) X ${rest}`, BOOT)?.exited).toBe(true);
  expect(procStat(`4243 (sleep) S ${rest}`, BOOT)?.exited).toBeUndefined();
  expect(psLine("  101   101 Ss   Sun Nov 15 08:00:00 2026  ")).toEqual([
    101,
    { pgid: 101, started: "ps:Sun Nov 15 08:00:00 2026" },
  ]);
  expect(psLine("  102   101 Z    Sun Nov 15 08:00:01 2026")).toEqual([
    102,
    { exited: true, pgid: 101, started: "ps:Sun Nov 15 08:00:01 2026" },
  ]);
  expect(psLine("  103   101 ZN   Sun Nov 15 08:00:02 2026")?.[1].exited).toBe(
    true
  );
  expect(psLine("not a line")).toBeUndefined();
});

it("compares starts of one kind only: another kind, or none, says nothing", () => {
  const linux = `linux:${BOOT}:987654`;
  expect(compareStarts(linux, `linux:${BOOT}:987654`)).toBe("same");
  expect(compareStarts(linux, `linux:${BOOT}:987655`)).toBe("different");
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
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const pid = child.pid ?? 0;
      const seen = join(dir, "seen");
      writeFileSync(seen, "Sun Nov 15 12:00:00 2026");
      writeFileSync(
        join(dir, "ps"),
        `#!/bin/sh\nif [ "$4" = "${String(pid)}" ]; then printf '${String(pid)} ${String(pid)} S '; cat '${seen}'; else exec /bin/ps "$@"; fi\n`,
        { mode: 0o700 }
      );
      const script = join(dir, "check.ts");
      writeFileSync(
        script,
        `const { isGone } = await import(${JSON.stringify(join(SRC, "node", "process-identity.ts"))});
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

function madeUp(
  alive: boolean,
  seen: SeenProcess | "absent" | undefined
): ProcessLookup {
  return {
    alive: () => alive,
    look: (pids) =>
      seen === undefined
        ? undefined
        : new Map(
            seen === "absent" ? [] : pids.map((pid) => [pid, seen] as const)
          ),
  };
}

const AT = "ps:Sun Nov 15 08:00:00 2026";

it("takes an owner that has exited and is not reaped (a zombie) for gone, though a signal still reaches it", () => {
  const asked: number[] = [];
  const exited = madeUp(true, { exited: true, pgid: 1, started: AT });
  const zombie: ProcessLookup = {
    alive: exited.alive,
    look: (pids) => {
      asked.push(...pids);
      return exited.look(pids);
    },
  };
  expect(isGone({ pid: 4_200_101, started: AT }, zombie)).toBe(true);
  expect(isGone({ pid: 4_200_102, started: null }, zombie)).toBe(true);
  expect(startedAt(4_200_103, zombie)).toBeNull();
  expect(asked).toEqual([4_200_101, 4_200_102, 4_200_103]);
});

it("never takes a running owner for gone when the system cannot say, or lists nothing for a pid that answers", () => {
  const running = madeUp(true, { pgid: 1, started: AT });
  expect(isGone({ pid: 4_200_111, started: AT }, running)).toBe(false);
  expect(isGone({ pid: 4_200_112, started: null }, running)).toBe(false);
  expect(isGone({ pid: 4_200_113, started: AT }, madeUp(true, undefined))).toBe(
    false
  );
  expect(startedAt(4_200_114, madeUp(true, undefined))).toBeUndefined();
  expect(isGone({ pid: 4_200_115, started: AT }, madeUp(true, "absent"))).toBe(
    false
  );
  expect(isGone({ pid: 4_200_116, started: AT }, madeUp(false, "absent"))).toBe(
    true
  );
  expect(
    isGone(
      { pid: 4_200_117, started: AT },
      madeUp(true, { pgid: 1, started: "ps:Sun Nov 15 09:00:00 2026" })
    )
  ).toBe(true);
  expect(startedAt(4_200_118, running)).toBe(AT);
});

it("reads a ps line only in its exact shape: anything truncated, reordered or extra is not one", () => {
  const good = "  4200201   4200201 Ss   Sun Nov  5 08:00:00 2026  ";
  expect(psLine(good)).toEqual([
    4_200_201,
    { pgid: 4_200_201, started: "ps:Sun Nov 5 08:00:00 2026" },
  ]);
  expect(psLine("12768 11558 ?NE  Sun Nov 15 22:33:54 2026    ")?.[0]).toBe(
    12_768
  );
  for (const line of [
    "",
    "   ",
    "4200201 4200201 S Sun Nov 15 08:00:00",
    "4200201 4200201 S Sun Nov 15 08:00",
    "4200201 4200201 S Sun Nov 15",
    "4200201 S 4200201 Sun Nov 15 08:00:00 2026",
    "4200201 4200201 Sun Nov 15 08:00:00 2026",
    "4200201 4200201 S Sun Nov 15 08:00:00 2026 extra",
    "4200201 4200201 S 4200201 Sun Nov 15 08:00:00 2026",
    "4200201 4200201 S Sun Foo 15 08:00:00 2026",
    "4200201 4200201 S Nov Sun 15 08:00:00 2026",
    "4200201 4200201 S Sun Nov 32 08:00:00 2026",
    "4200201 4200201 S Sun Nov 15 25:00:00 2026",
    "4200201 4200201 S Sun Nov 15 08:61:00 2026",
    "4200201 4200201 S Sun Nov 15 08:00:00 26",
    "4200201 4200201 - Sun Nov 15 08:00:00 2026",
    "4200201 4200201 s Sun Nov 15 08:00:00 2026",
  ]) {
    expect({ line, parsed: psLine(line) }).toEqual({ line, parsed: undefined });
  }
});

it("takes a listing with any line it cannot read for one it cannot tell anything from", () => {
  const good = "  4200211   4200211 Ss   Sun Nov 15 08:00:00 2026";
  expect(psListing("")?.size).toBe(0);
  expect(psListing(`${good}\n\n`)?.size).toBe(1);
  expect(
    psListing(`${good}\n  4200212   4200211 S    Sun Nov 15 08:00:00\n`)
  ).toBeUndefined();
  expect(psListing("ps: something went wrong\n")).toBeUndefined();
  const truncated: ProcessLookup = {
    alive: () => true,
    look: () => psListing("4200213 1 S Sun Nov 15 08:00:00\n"),
  };
  expect(
    isGone(
      { pid: 4_200_213, started: "ps:Sun Nov 15 08:00:00 2026" },
      truncated
    )
  ).toBe(false);
});

it("reads a /proc stat line only with a boot id and a state of their shapes", () => {
  const rest =
    "1 4242 4242 0 -1 4194560 120 0 0 0 3 1 0 0 20 0 1 0 987654 1000 200";
  expect(procStat(`4243 (sleep) S ${rest}`, "not-a-boot-id")).toBeUndefined();
  expect(procStat(`4243 (sleep) S ${rest}`, "")).toBeUndefined();
  expect(procStat(`4243 (sleep) ?? ${rest}`, BOOT)).toBeUndefined();
  expect(procStat(`4243 (sleep) S ${rest}`, BOOT)?.started).toBe(
    `linux:${BOOT}:987654`
  );
});

it("says a process is gone only on proof, running only on its start, and cannot tell otherwise", () => {
  const at = { pid: 4_200_301, started: AT };
  const cases: [string, ProcessLookup, string][] = [
    ["no signal reaches it", madeUp(false, "absent"), "gone"],
    [
      "listed exited, a signal reaching it",
      madeUp(true, { exited: true, pgid: 1, started: AT }),
      "gone",
    ],
    [
      "listed with another start",
      madeUp(true, { pgid: 1, started: "ps:Sun Nov 15 09:00:00 2026" }),
      "gone",
    ],
    [
      "listed with its start",
      madeUp(true, { pgid: 1, started: AT }),
      "running",
    ],
    ["unlisted, a signal reaching it", madeUp(true, "absent"), "unknown"],
    ["the listing failed", madeUp(true, undefined), "unknown"],
    [
      "a start of another kind",
      madeUp(true, { pgid: 1, started: "linux:x:1" }),
      "unknown",
    ],
  ];
  for (const [what, lookup, state] of cases) {
    expect({ state: processState(at, lookup), what }).toEqual({ state, what });
  }
  expect(startedAt(4_200_302, madeUp(true, "absent"))).toBeUndefined();
  expect(startedAt(4_200_303, madeUp(false, "absent"))).toBeNull();
});

it("passes over, in a /proc listing, a process whose stat another user keeps, or that went mid-read, and fails only on one it cannot make sense of", () => {
  const rest =
    "1 4242 4242 0 -1 4194560 120 0 0 0 3 1 0 0 20 0 1 0 987654 1000 200";
  const failing = (code: string) => {
    throw Object.assign(new Error(code), { code });
  };
  const read = (pid: number): string => {
    if (pid === 2) {
      return failing("EACCES");
    }
    if (pid === 3) {
      return failing("EPERM");
    }
    if (pid === 4) {
      return failing("ESRCH");
    }
    if (pid === 5) {
      return failing("ENOENT");
    }
    return `${String(pid)} (sleep) S ${rest}`;
  };
  expect([...(procListing([1, 2, 3, 4, 5], read, BOOT) ?? []).keys()]).toEqual([
    1,
  ]);
  expect(
    procListing([1, 6], (pid) => (pid === 6 ? failing("EIO") : read(pid)), BOOT)
  ).toBeUndefined();
  expect(
    procListing([1, 7], (pid) => (pid === 7 ? "garbled" : read(pid)), BOOT)
  ).toBeUndefined();
});

it("takes a group's id for another's when a process with the leader's pid runs with another start, or once the leader is reaped", () => {
  const leader = { pid: 4_200_500, started: AT };
  expect(
    groupIdTaken(leader, {
      pgid: 4_200_500,
      started: "ps:Sun Nov 15 09:00:00 2026",
    })
  ).toBe(true);
  expect(groupIdTaken(leader, { pgid: 4_200_500, started: AT })).toBe(false);
  expect(
    groupIdTaken(leader, {
      exited: true,
      pgid: 4_200_500,
      started: "ps:Sun Nov 15 09:00:00 2026",
    })
  ).toBe(false);
  expect(groupIdTaken(leader, undefined)).toBe(false);
  expect(
    groupIdTaken(
      { pid: 4_200_500, started: null },
      { pgid: 4_200_500, started: AT }
    )
  ).toBe(false);
  expect(
    groupIdTaken(
      { pid: 4_200_500, started: null },
      { pgid: 4_200_500, started: AT },
      true
    )
  ).toBe(true);
});

it("pure startedAt works with an explicit lookup and node/process-identity performs no I/O at import time", () => {
  const running = madeUp(true, { pgid: 1, started: AT });
  expect(pureStartedAt(4_200_600, running)).toBe(AT);
  expect(pureStartedAt(4_200_601, madeUp(false, "absent"))).toBeNull();

  const dir = mkdtempSync(join(tmpdir(), "identity-lazy-"));
  try {
    const marker = join(dir, "ps-called");
    writeFileSync(
      join(dir, "ps"),
      `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexec /bin/ps "$@"\n`,
      { mode: 0o700 }
    );
    const script = join(dir, "import-only.ts");
    writeFileSync(
      script,
      `import { existsSync } from "node:fs";
const mod = await import(${JSON.stringify(join(SRC, "node", "process-identity.ts"))});
const calledOnImport = existsSync(${JSON.stringify(marker)});
const self = mod.thisProcess();
console.log(JSON.stringify({ calledOnImport, pid: self.pid }));`
    );
    const output = execFileSync("bun", [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });
    const parsed = JSON.parse(output.trim()) as {
      calledOnImport: boolean;
      pid: number;
    };
    expect(parsed.calledOnImport).toBe(false);
    expect(parsed.pid).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
