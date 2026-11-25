import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  lookProcesses,
  processAlive,
  processState,
} from "@foundry/lib/node/process-identity";
import { anotherStart } from "@foundry/lib/testing/process-identity";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it, vi } from "vitest";
import { readLiveGenerations } from "~/database/generations";
import { layout } from "~/layout";
import { daemonAlive } from "~/process/client";
import { readProcess } from "~/process/instance";
import { recordSpawned, SPAWN_RECORD_ENV, startedAt } from "~/process/spawned";
import integration from "../vitest.integration.config";
import { cliArgs } from "./helpers/cli";
import { testHome } from "./helpers/home";
import { RecordedStdioTransport } from "./helpers/mcp-stdio";
import {
  type Marker,
  type ProcessSystem,
  parseMembers,
  recordProcess,
  stopRecorded,
  unrecordedMarked,
} from "./helpers/processes";
import {
  RUN_ENV,
  removeRoot,
  runIsOver,
  runRecords,
  startRun,
  sweepFinishedRuns,
} from "./helpers/runs";
import { temporaryDirectory } from "./helpers/temporary";

function uniqueMarker(): Marker {
  return { name: "MARBLES_TEST_PROBE", value: temporaryDirectory("mk-") };
}

const entry = (marker: Marker) => `${marker.name}=${marker.value}`;

function writePrivateFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { mode: 0o700, recursive: true });
}

async function sleeper(
  env: Record<string, string>,
  {
    args = [] as readonly string[],
    ignoreTerm = false,
    inGroup = true,
    script = "",
  } = {}
): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `${ignoreTerm ? 'process.on("SIGTERM", () => undefined);' : ""}${script} console.log("ready"); setInterval(() => undefined, 1000);`,
      ...args,
    ],
    { detached: inGroup, env, stdio: ["ignore", "pipe", "inherit"] }
  );
  await new Promise<void>((settle) => {
    child.stdout.once("data", () => settle());
  });
  child.stdout.destroy();
  child.unref();
  if (child.pid === undefined) {
    throw new Error("could not start a sleeper");
  }
  return child.pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kill(...pids: number[]): void {
  for (const pid of pids) {
    if (alive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
}

const gone = (pid: number) =>
  vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });

const FAST = { graceMs: 300, killMs: 2000 };

it("records a process Marbles starts only where FOUNDRY_TEST_SPAWN_RECORD points", async () => {
  const records = temporaryDirectory("rec-");
  const pid = await sleeper({});
  try {
    recordSpawned(pid, true, { env: {} });
    expect(readdirSync(records)).toEqual([]);
    recordSpawned(pid, true, { env: { [SPAWN_RECORD_ENV]: records } });
    expect(
      JSON.parse(readFileSync(join(records, `${String(pid)}.json`), "utf8"))
    ).toEqual({ group: true, pid, started: startedAt(pid) });
  } finally {
    kill(pid);
  }
});

it("reads a marker from the environment only, never from the command line", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const inEnvironment = await sleeper({ [marker.name]: marker.value });
  const inArguments = await sleeper({ OTHER: "1" }, { args: [entry(marker)] });
  const recordedArguments = await sleeper(
    { OTHER: "1" },
    { args: [entry(marker)] }
  );
  recordProcess(records, recordedArguments, true);
  try {
    expect(unrecordedMarked(records, marker)).toEqual([inEnvironment]);
    const problems = await stopRecorded(records, marker, FAST);
    expect(problems).toEqual([
      expect.stringContaining(
        `process ${String(recordedArguments)} matches its record`
      ),
    ]);
    expect(alive(recordedArguments)).toBe(true);
  } finally {
    kill(inEnvironment, inArguments, recordedArguments);
  }
});

it("proves a recorded process again before every signal, so a reused pid gets none", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  writePrivateFile(
    join(records, "4242.json"),
    JSON.stringify({
      group: true,
      pid: 4242,
      started: "Sun Nov 15 08:00:00 2026",
    })
  );
  let started = "Sun Nov 15 08:00:00 2026";
  const sent: [number, NodeJS.Signals][] = [];
  const system: ProcessSystem = {
    alive: () => true,
    environment: () => [entry(marker)],
    kill(target, signal) {
      sent.push([target, signal]);
      started = "Sun Nov 15 09:00:00 2026";
    },
    look: (pids) => new Map(pids.map((pid) => [pid, { pgid: pid, started }])),
    members: () => [],
    sleep: () => Promise.resolve(),
  };
  expect(
    await stopRecorded(records, marker, { graceMs: 0, killMs: 0 }, system)
  ).toEqual([]);
  expect(sent).toEqual([[-4242, "SIGTERM"]]);
});

it("forgets a run's record only on proof its process is gone: never one unlisted that a signal reaches, nor one of a start it cannot compare", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const pid = 4_200_400;
  const started = "ps:Sun Nov 15 08:00:00 2026";
  const path = join(records, `${String(pid)}.json`);
  const stop = (system: Partial<ProcessSystem>) =>
    stopRecorded(
      records,
      marker,
      { graceMs: 0, killMs: 0 },
      {
        alive: () => false,
        environment: () => [entry(marker)],
        kill: () => {
          throw new Error("nothing here may be signalled");
        },
        look: () => new Map(),
        members: () => [],
        sleep: () => Promise.resolve(),
        ...system,
      }
    );
  const put = (start: string) =>
    writePrivateFile(
      path,
      JSON.stringify({ group: false, pid, started: start })
    );

  put(started);
  expect(await stop({ alive: (each) => each === pid })).toEqual([
    expect.stringContaining("is not listed but a signal still reaches it"),
  ]);
  expect(existsSync(path)).toBe(true);

  put("linux:00000000-0000-0000-0000-000000000000:1");
  expect(
    await stop({
      alive: () => true,
      look: () => new Map([[pid, { pgid: 1, started }]]),
    })
  ).toEqual([expect.stringContaining("a start of a kind this system cannot")]);
  expect(existsSync(path)).toBe(true);

  put(started);
  expect(
    await stop({
      alive: () => true,
      look: () => new Map([[pid, { exited: true, pgid: 1, started }]]),
    })
  ).toEqual([]);
  expect(existsSync(records)).toBe(false);
});

function madeUpSystem(
  marker: Marker,
  running: Set<number>,
  started: string,
  onKill: (target: number) => void = () => undefined
): {
  readonly sent: [number, NodeJS.Signals][];
  readonly system: ProcessSystem;
} {
  const sent: [number, NodeJS.Signals][] = [];
  return {
    sent,
    system: {
      alive: (pid) => running.has(pid),
      environment: (pid) => (running.has(pid) ? [entry(marker)] : undefined),
      kill(target, signal) {
        sent.push([target, signal]);
        running.delete(Math.abs(target));
        onKill(target);
      },
      look: (pids) =>
        new Map(
          pids
            .filter((pid) => running.has(pid))
            .map((pid) => [pid, { pgid: 1, started }])
        ),
      members: () => [],
      sleep: () => Promise.resolve(),
    },
  };
}

it("stops a process recorded while the stop runs, and keeps its record until it is gone", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const started = "Sun Nov 15 08:00:00 2026";
  const record = (pid: number) =>
    writePrivateFile(
      join(records, `${String(pid)}.json`),
      JSON.stringify({ group: false, pid, started })
    );
  record(5151);
  const running = new Set([5151]);
  const { sent, system } = madeUpSystem(marker, running, started, (target) => {
    if (target === 5151) {
      running.add(5252);
      record(5252);
    }
  });
  expect(
    await stopRecorded(records, marker, { graceMs: 0, killMs: 0 }, system)
  ).toEqual([]);
  expect(sent).toEqual([
    [5151, "SIGTERM"],
    [5252, "SIGTERM"],
  ]);
  expect(existsSync(records)).toBe(false);
});

it("keeps, as not clear, the records directory while a record is still being written there, and removes a dead writer's", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const nested = join(records, "home");
  mkdirPrivate(nested);
  const dead = join(nested, ".1.json.dead.tmp");
  writePrivateFile(dead, "{");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(dead, old, old);
  const { system } = madeUpSystem(marker, new Set(), "");
  expect(
    await stopRecorded(records, marker, { graceMs: 0, killMs: 0 }, system)
  ).toEqual([]);
  expect(existsSync(records)).toBe(false);

  const writing = temporaryDirectory("rec-");
  writePrivateFile(join(writing, ".2.json.live.tmp"), "{");
  expect(
    await stopRecorded(writing, marker, { graceMs: 0, killMs: 0 }, system)
  ).toEqual([expect.stringContaining("a record still being written")]);
  expect(existsSync(join(writing, ".2.json.live.tmp"))).toBe(true);

  const odd = temporaryDirectory("rec-");
  writePrivateFile(join(odd, "notes.txt"), "?");
  expect(
    await stopRecorded(odd, marker, { graceMs: 0, killMs: 0 }, system)
  ).toEqual([expect.stringContaining("notes.txt, not a record")]);
  expect(existsSync(odd)).toBe(true);
});

it("takes a group's member that has exited but is not reaped (a zombie) for gone", () => {
  const members = [
    "  101   101 Ss",
    "  102   101 Z",
    "  103   101 ZN",
    "  104   101 S+",
    "  105   202 S",
  ].join("\n");
  expect(parseMembers(members, 101)).toEqual([101, 104]);
  expect(parseMembers("  102   101 Z", 101)).toEqual([]);
});

it("does not signal a recorded process whose pid now names one that started later", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const later = await sleeper({ [marker.name]: marker.value });
  writePrivateFile(
    join(records, `${String(later)}.json`),
    JSON.stringify({
      group: true,
      pid: later,
      started: anotherStart(),
    })
  );
  try {
    expect(await stopRecorded(records, marker, FAST)).toEqual([]);
    expect(alive(later)).toBe(true);
  } finally {
    kill(later);
  }
});

it("stops a recorded platform binary whose environment the system hides", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const child = spawn("/bin/sleep", ["60"], {
    detached: true,
    env: { [marker.name]: marker.value },
    stdio: "ignore",
  });
  const pid = child.pid ?? 0;
  recordProcess(records, pid, true);
  child.unref();
  try {
    expect(await stopRecorded(records, marker, FAST)).toEqual([]);
    await gone(pid);
    expect(existsSync(records)).toBe(false);
  } finally {
    kill(pid);
  }
});

it("stops a recorded group leader with the unrecorded children in its group", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const reported = `${marker.value}/child`;
  const leader = await sleeper(
    { [marker.name]: marker.value },
    {
      script:
        `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { env: {}, stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(reported)}, String(child.pid));`.replaceAll(
          "\n",
          " "
        ),
    }
  );
  recordProcess(records, leader, true);
  const child = Number(readFileSync(reported, "utf8"));
  expect(await stopRecorded(records, marker, FAST)).toEqual([]);
  await gone(child);
});

it("reports, and does not signal, what outlives the recorded leader of its group", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const reported = `${marker.value}/child`;
  const ready = `${marker.value}/ready`;
  const leader = await sleeper(
    { [marker.name]: marker.value },
    {
      script:
        `const child = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); require('node:fs').writeFileSync('${ready}', ''); setInterval(() => undefined, 1000)"], { env: {}, stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(reported)}, String(child.pid));`.replaceAll(
          "\n",
          " "
        ),
    }
  );
  recordProcess(records, leader, true);
  const child = Number(readFileSync(reported, "utf8"));
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    const problems = await stopRecorded(records, marker, FAST);
    expect(problems).toEqual([
      expect.stringContaining(
        `process ${String(child)} is in the group of the recorded process ${String(leader)}`
      ),
    ]);
    expect(alive(child)).toBe(true);
    expect(existsSync(records)).toBe(true);
  } finally {
    kill(child);
  }
});

it("reports, and does not signal, what is left in the group of a recorded leader that has already exited", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const reported = `${marker.value}/child`;
  const leader = await sleeper(
    { [marker.name]: marker.value },
    {
      script: `const child = require("node:child_process").spawn("/bin/sleep", ["60"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(reported)}, String(child.pid)); setTimeout(() => process.exit(0), 200);`,
    }
  );
  recordProcess(records, leader, true);
  const child = Number(readFileSync(reported, "utf8"));
  try {
    await gone(leader);
    expect(await stopRecorded(records, marker, FAST)).toEqual([
      expect.stringContaining(
        `process ${String(child)} is in the group of the recorded process ${String(leader)}`
      ),
    ]);
    expect(alive(child)).toBe(true);
    expect(existsSync(records)).toBe(true);
  } finally {
    kill(child);
  }
});

it("does not signal a recorded process whose environment cannot be read, and reports it", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const started = "Sun Nov 15 08:00:00 2026";
  writePrivateFile(
    join(records, "4343.json"),
    JSON.stringify({ group: false, pid: 4343, started })
  );
  const sent: [number, NodeJS.Signals][] = [];
  const system: ProcessSystem = {
    alive: () => true,
    environment: () => undefined,
    kill: (target, signal) => {
      sent.push([target, signal]);
    },
    look: (pids) => new Map(pids.map((pid) => [pid, { pgid: 1, started }])),
    members: () => [],
    sleep: () => Promise.resolve(),
  };
  expect(
    await stopRecorded(records, marker, { graceMs: 0, killMs: 0 }, system)
  ).toEqual([expect.stringContaining("could not be proved; not signalled")]);
  expect(sent).toEqual([]);
});

it("reports a recorded process that no longer leads its recorded group, and does not signal it", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const pid = await sleeper(
    { [marker.name]: marker.value },
    { inGroup: false }
  );
  recordProcess(records, pid, true);
  try {
    expect(await stopRecorded(records, marker, FAST)).toEqual([
      expect.stringContaining("was recorded leading its own group"),
    ]);
    expect(alive(pid)).toBe(true);
  } finally {
    kill(pid);
  }
});

it("kills a recorded process that ignores SIGTERM once the grace period ends", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const pid = await sleeper(
    { [marker.name]: marker.value },
    { ignoreTerm: true }
  );
  recordProcess(records, pid, true);
  const began = Date.now();
  expect(await stopRecorded(records, marker, FAST)).toEqual([]);
  expect(Date.now() - began).toBeGreaterThanOrEqual(FAST.graceMs);
  await gone(pid);
});

it("stops only what its own records name", async () => {
  const marker = uniqueMarker();
  const mine = temporaryDirectory("rec-");
  const theirs = temporaryDirectory("rec-");
  const a = await sleeper({ [marker.name]: marker.value });
  const b = await sleeper({ [marker.name]: marker.value });
  recordProcess(mine, a, true);
  recordProcess(theirs, b, true);
  try {
    expect(await stopRecorded(mine, marker, FAST)).toEqual([]);
    await gone(a);
    expect(alive(b)).toBe(true);
  } finally {
    kill(a, b);
  }
});

async function killedRun(parent: string): Promise<{
  readonly leftover: number;
  readonly root: string;
}> {
  const script = join(parent, "run.ts");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { recordProcess } from ${JSON.stringify(resolve("test/helpers/processes.ts"))};
import { startRun } from ${JSON.stringify(resolve("test/helpers/runs.ts"))};
const run = startRun(${JSON.stringify(parent)});
const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, env: { ${RUN_ENV}: run.root }, stdio: "ignore" });
recordProcess(run.records + "/run", child.pid, true);
child.unref();
console.log(JSON.stringify({ leftover: child.pid, root: run.root }));
setInterval(() => undefined, 1000);
`
  );
  const owner = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = await new Promise<string>((settle) => {
    owner.stdout.once("data", (chunk: Buffer) => settle(chunk.toString()));
  });
  owner.kill("SIGKILL");
  await new Promise((settle) => owner.once("exit", settle));
  return JSON.parse(line) as { leftover: number; root: string };
}

it("sweeps a killed run: stops what its records name and removes its root", async () => {
  const parent = temporaryDirectory("sw-");
  const { leftover, root } = await killedRun(parent);
  expect(alive(leftover)).toBe(true);
  await sweepFinishedRuns(parent, FAST);
  await gone(leftover);
  expect(existsSync(root)).toBe(false);
});

function exitedPid(): number {
  const exited = spawnSync(
    process.execPath,
    ["-e", "console.log(process.pid)"],
    {
      encoding: "utf8",
    }
  );
  return Number(exited.stdout.trim());
}

function forgedRun(
  parent: string,
  name: string,
  pid: number,
  { recordMode = 0o600, rootMode = 0o700 } = {}
): string {
  const root = join(parent, name);
  mkdirPrivate(join(runRecords(root), "run"));
  chmodSync(root, rootMode);
  writePrivateFile(
    join(root, "owner.json"),
    JSON.stringify({ pid: exitedPid(), started: anotherStart() })
  );
  const record = join(runRecords(root), "run", `${String(pid)}.json`);
  writeFileSync(
    record,
    JSON.stringify({ group: false, pid, started: startedAt(pid) }),
    { mode: recordMode }
  );
  chmodSync(record, recordMode);
  return root;
}

it("acts on nothing in a run root, a record or a link that is not private", async () => {
  const parent = temporaryDirectory("sw-");
  const unrelated = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  const pid = unrelated.pid ?? 0;
  const open = forgedRun(parent, "marbles-run-open", pid, { rootMode: 0o755 });
  const loose = forgedRun(parent, "marbles-run-loose", pid, {
    recordMode: 0o644,
  });
  const elsewhere = forgedRun(temporaryDirectory("sw-"), "marbles-run-x", pid);
  symlinkSync(elsewhere, join(parent, "marbles-run-linked"));
  const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await sweepFinishedRuns(parent, FAST);
    expect(alive(pid)).toBe(true);
    expect([open, loose, elsewhere].map(existsSync)).toEqual([
      true,
      true,
      true,
    ]);
    const said = warned.mock.calls.flat().join("\n");
    expect(said).toContain(`${open} is open to group or others`);
    expect(said).toContain("is open to group or others (mode 644)");
    expect(said).toContain(
      `${join(parent, "marbles-run-linked")} is a symbolic link`
    );
  } finally {
    warned.mockRestore();
    kill(pid);
  }
});

it("will not keep runs in, or sweep, a base directory open to others", async () => {
  const base = temporaryDirectory("base-");
  chmodSync(base, 0o755);
  expect(() => startRun(base)).toThrow("is open to group or others");
  const unrelated = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  const pid = unrelated.pid ?? 0;
  const root = forgedRun(base, "marbles-run-forged", pid);
  const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await sweepFinishedRuns(base, FAST);
    expect(alive(pid)).toBe(true);
    expect(existsSync(root)).toBe(true);
    expect(warned.mock.calls.flat().join("\n")).toContain(
      `not sweeping ${base}`
    );
  } finally {
    warned.mockRestore();
    kill(pid);
  }
});

it("reads each process's identity again right before its own signal", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const old = "Sun Nov 15 08:00:00 2026";
  for (const pid of [111, 222]) {
    writePrivateFile(
      join(records, `${String(pid)}.json`),
      JSON.stringify({ group: false, pid, started: old })
    );
  }
  const started = new Map([
    [111, old],
    [222, old],
  ]);
  const sent: [number, NodeJS.Signals][] = [];
  const system: ProcessSystem = {
    alive: (pid) => started.has(pid),
    environment: () => [entry(marker)],
    kill(target, signal) {
      sent.push([target, signal]);
      started.delete(target);
      const other = target === 111 ? 222 : 111;
      if (started.has(other)) {
        started.set(other, "Sun Nov 15 09:00:00 2026");
      }
    },
    look: (pids) =>
      new Map(
        pids.flatMap((pid) => {
          const at = started.get(pid);
          return at === undefined ? [] : [[pid, { pgid: 1, started: at }]];
        })
      ),
    members: () => [],
    sleep: () => Promise.resolve(),
  };
  expect(
    await stopRecorded(records, marker, { graceMs: 0, killMs: 0 }, system)
  ).toEqual([]);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.[1]).toBe("SIGTERM");
});

it("starts the Marbles process all the same when it cannot be recorded", async () => {
  const home = temporaryDirectory("h-");
  const shared = temporaryDirectory("rec-");
  chmodSync(shared, 0o755);
  const source = join(home, "marbles.ts");
  writeFileSync(
    source,
    'import { step } from "@foundry.sh/marbles";\nstep("noop").do(() => "ok");\n'
  );
  const env = {
    ...process.env,
    FOUNDRY_HOME: home,
    [SPAWN_RECORD_ENV]: shared,
  };
  const attached = spawnSync(
    "bun",
    cliArgs("daemon", "attach", "--source", source),
    {
      encoding: "utf8",
      env,
      timeout: 60_000,
    }
  );
  try {
    expect(attached.status, attached.stderr).toBe(0);
    expect(attached.stderr).toContain("could not record process");
    expect(daemonAlive(layout({ home }))).toBe(true);
    expect(readdirSync(shared)).toEqual([]);
  } finally {
    spawnSync("bun", cliArgs("daemon", "stop"), { env, timeout: 60_000 });
    await vi.waitFor(() => expect(daemonAlive(layout({ home }))).toBe(false), {
      timeout: 30_000,
    });
  }
}, 120_000);

it("keeps a run whose records cannot be read, and still clears the others", async () => {
  const parent = temporaryDirectory("sw-");
  const broken = join(parent, "marbles-run-broken");
  mkdirPrivate(join(runRecords(broken), "run"));
  writePrivateFile(
    join(broken, "owner.json"),
    JSON.stringify({ pid: exitedPid(), started: anotherStart() })
  );
  writePrivateFile(join(runRecords(broken), "run", "1.json"), "{ not json");
  const killed = await killedRun(parent);
  await sweepFinishedRuns(parent, FAST);
  expect(existsSync(broken)).toBe(true);
  await gone(killed.leftover);
  expect(existsSync(killed.root)).toBe(false);
});

it("lets several runs sweep the same killed run at once", async () => {
  const parent = temporaryDirectory("sw-");
  const killed = await killedRun(parent);
  const script = join(parent, "sweep.ts");
  writeFileSync(
    script,
    `import { sweepFinishedRuns } from ${JSON.stringify(resolve("test/helpers/runs.ts"))};
await sweepFinishedRuns(${JSON.stringify(parent)}, { graceMs: 300, killMs: 2000 });
`
  );
  const sweeps = await Promise.all(
    Array.from(
      { length: 6 },
      () =>
        new Promise<number | null>((settle) => {
          const sweeper = spawn(process.execPath, [script], {
            stdio: "ignore",
          });
          sweeper.once("exit", settle);
        })
    )
  );
  expect(sweeps).toEqual([0, 0, 0, 0, 0, 0]);
  await gone(killed.leftover);
  expect(existsSync(killed.root)).toBe(false);
}, 30_000);

it("keeps a run's root while a process carries its marker without a record, and leaves that process alone", async () => {
  const parent = temporaryDirectory("sw-");
  const run = startRun(parent, FAST);
  const recorded = await sleeper({ [RUN_ENV]: run.root });
  recordProcess(join(run.records, "run"), recorded, true);
  const unrecorded = await sleeper({ [RUN_ENV]: run.root });
  try {
    await run.finish();
    await gone(recorded);
    expect(alive(unrecorded)).toBe(true);
    expect(existsSync(run.root)).toBe(true);
  } finally {
    kill(unrecorded);
  }
});

it("takes a run for over only as the one rule for owners does: never for one a signal reaches that the listing leaves out", () => {
  const parent = temporaryDirectory("sw-");
  const root = join(parent, "marbles-run-made-up");
  mkdirPrivate(root);
  writePrivateFile(
    join(root, "owner.json"),
    JSON.stringify({ pid: 4_200_130, started: "ps:Sun Nov 15 08:00:00 2026" })
  );
  const unlisted = { alive: () => true, look: () => new Map() };
  expect(runIsOver(root, unlisted)).toBe(false);
  const exited = {
    alive: () => true,
    look: () =>
      new Map([
        [
          4_200_130,
          {
            exited: true as const,
            pgid: 1,
            started: "ps:Sun Nov 15 08:00:00 2026",
          },
        ],
      ]),
  };
  expect(runIsOver(root, exited)).toBe(true);
  expect(runIsOver(root, { alive: () => false, look: () => new Map() })).toBe(
    true
  );
});

it("keeps a run's root while a record is still being written in it, and never removes a root a record came back to", async () => {
  const parent = temporaryDirectory("sw-");
  const run = startRun(parent, FAST);
  mkdirPrivate(join(run.records, "run"));
  writePrivateFile(join(run.records, "run", ".9.json.live.tmp"), "{");
  await run.finish();
  expect(existsSync(join(run.records, "run", ".9.json.live.tmp"))).toBe(true);

  const other = startRun(parent, FAST);
  mkdirPrivate(other.records);
  writePrivateFile(join(other.records, "9.json"), "{}");
  expect(await removeRoot(other.root)).toEqual(
    expect.arrayContaining([expect.stringContaining("is not a process record")])
  );
  expect(
    readdirSync(parent, { recursive: true }).filter((name) =>
      String(name).endsWith("9.json")
    )
  ).toHaveLength(1);
});

it("leaves a run whose owner's start is of a kind it cannot compare, as one it cannot tell over", async () => {
  const parent = temporaryDirectory("sw-");
  const root = join(parent, "marbles-run-other-kind");
  mkdirPrivate(join(root, "spawned"));
  writePrivateFile(
    join(root, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      started: "Sun Nov 15 08:00:00 2026",
    })
  );
  await sweepFinishedRuns(parent, FAST);
  expect(existsSync(join(root, "spawned"))).toBe(true);
});

it("leaves a live run whose owner started under another time zone and language", async () => {
  const parent = temporaryDirectory("sw-");
  const script = join(parent, "owner.ts");
  writeFileSync(
    script,
    `import { startRun } from ${JSON.stringify(resolve("test/helpers/runs.ts"))};
const run = startRun(${JSON.stringify(parent)});
console.log(run.root);
setInterval(() => undefined, 1000);
`
  );
  const owner = spawn(process.execPath, [script], {
    env: { ...process.env, LC_ALL: "fr_FR.UTF-8", TZ: "Asia/Tokyo" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const root = await new Promise<string>((settle) => {
      owner.stdout.once("data", (chunk: Buffer) =>
        settle(chunk.toString().trim())
      );
    });
    await sweepFinishedRuns(parent, FAST);
    expect(existsSync(root)).toBe(true);
  } finally {
    owner.kill("SIGKILL");
  }
});

it("sweeps a run whose owner's pid now names a process started later", async () => {
  const parent = temporaryDirectory("sw-");
  const reused = await sleeper({});
  const root = join(parent, "marbles-run-reused");
  mkdirPrivate(root);
  writePrivateFile(
    join(root, "owner.json"),
    JSON.stringify({ pid: reused, started: anotherStart() })
  );
  const leftover = await sleeper({ [RUN_ENV]: root });
  recordProcess(join(runRecords(root), "run"), leftover, true);
  try {
    await sweepFinishedRuns(parent, FAST);
    await gone(leftover);
    expect(existsSync(root)).toBe(false);
    expect(alive(reused)).toBe(true);
  } finally {
    kill(reused);
  }
});

it("leaves a live run and a root whose owner cannot be read alone, and handles the records of one that names no owner", async () => {
  const parent = temporaryDirectory("sw-");
  const live = startRun(parent, FAST);
  const liveChild = await sleeper({ [RUN_ENV]: live.root });
  recordProcess(join(live.records, "run"), liveChild, true);
  const silent = join(parent, "marbles-run-silent");
  mkdirPrivate(silent);
  const silentChild = await sleeper({ [RUN_ENV]: silent });
  recordProcess(join(runRecords(silent), "run"), silentChild, true);
  const garbled = join(parent, "marbles-run-garbled");
  mkdirPrivate(garbled);
  writePrivateFile(join(garbled, "owner.json"), '{"pid": 1');
  const killed = await killedRun(parent);
  try {
    await sweepFinishedRuns(parent, FAST);
    expect(existsSync(killed.root)).toBe(false);
    await gone(killed.leftover);
    await gone(silentChild);
    expect([live.root, silent, garbled].map(existsSync)).toEqual([
      true,
      false,
      true,
    ]);
    expect(alive(liveChild)).toBe(true);
  } finally {
    await live.finish();
    kill(silentChild);
  }
  await gone(liveChild);
  expect(existsSync(live.root)).toBe(false);
});

const left: { home?: string; pid?: number; started?: string | null } = {};

it("records the Marbles process a test's CLI starts in the test's home", async () => {
  const home = testHome();
  const source = join(home.path, "marbles.ts");
  writeFileSync(
    source,
    'import { step } from "@foundry.sh/marbles";\nstep("noop").do(() => "ok");\n'
  );
  const attached = spawnSync(
    "bun",
    cliArgs("daemon", "attach", "--source", source),
    {
      encoding: "utf8",
      env: home.env,
      timeout: 60_000,
    }
  );
  expect(attached.status, attached.stderr).toBe(0);
  const records = home.env[SPAWN_RECORD_ENV] ?? "";
  const recorded = readdirSync(records).map((name) =>
    JSON.parse(readFileSync(join(records, name), "utf8"))
  );
  const daemonPid = readProcess(home.layout.state)?.pid;
  const daemon = recorded.find((record) => record.pid === daemonPid);
  expect(daemon?.group).toBe(true);
  expect(daemon?.started).toBe(startedAt(daemon?.pid));
  const [generation] = await readLiveGenerations(home.layout.state);
  expect(generation?.state).toBe("current");
  expect(
    recorded.find((record) => record.pid === generation?.pid)
  ).toMatchObject({
    group: true,
    started: generation?.started,
  });
  left.home = home.path;
  left.pid = daemon?.pid;
  left.started = daemon?.started;
}, 60_000);

it("stops that process and removes the home when the test finishes", () => {
  expect(left.pid).toBeDefined();
  expect(
    processState(
      { pid: left.pid ?? 0, started: left.started ?? null },
      { alive: processAlive, look: lookProcesses }
    )
  ).toBe("gone");
  expect(existsSync(left.home ?? "")).toBe(false);
});

it("records the MCP server that marbles mcp relays", async () => {
  const home = testHome();
  const transport = new RecordedStdioTransport({
    args: ["--no-env-file", resolve("src/cli.ts"), "mcp", "--dry-run"],
    command: "bun",
    cwd: home.path,
    env: home.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "test-run", version: "1.0.0" });
  await client.connect(transport);
  try {
    const records = home.env[SPAWN_RECORD_ENV] ?? "";
    expect(
      readdirSync(records).map((name) => Number(name.slice(0, -".json".length)))
    ).toEqual(expect.arrayContaining([transport.pid]));
    expect(readdirSync(records)).toHaveLength(2);
  } finally {
    await client.close();
  }
}, 30_000);

function guard(env: NodeJS.ProcessEnv) {
  return spawnSync("bun", [resolve("test/helpers/guard.ts")], {
    encoding: "utf8",
    env,
  });
}

it("refuses a test process that would use the developer's home", () => {
  const {
    [RUN_ENV]: _run,
    FOUNDRY_HOME: _home,
    HOME: _user,
    ...env
  } = process.env;
  const refused = guard(env);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("would use the developer's home");
}, 30_000);

it("judges the guard's paths with their links resolved", () => {
  const root = temporaryDirectory("gd-");
  const user = join(root, "user");
  mkdirSync(user);
  const outside = temporaryDirectory("gd-out-");
  symlinkSync(outside, join(root, "link"));
  const escaped = guard({
    ...process.env,
    FOUNDRY_HOME: join(root, "link", "home"),
    HOME: user,
    [RUN_ENV]: root,
  });
  expect(escaped.status).not.toBe(0);
  expect(escaped.stderr).toContain("would use the developer's home");
  const other = join(temporaryDirectory("gd-alias-"), "root");
  symlinkSync(root, other);
  const spelled = guard({
    ...process.env,
    FOUNDRY_HOME: join(root, "home"),
    HOME: user,
    [RUN_ENV]: other,
  });
  expect(spelled.status, spelled.stderr).toBe(0);
}, 30_000);

it("makes a process that lost FOUNDRY_HOME but kept HOME fail instead of using the default home", () => {
  const { FOUNDRY_HOME: _home, ...env } = process.env;
  const status = spawnSync("bun", cliArgs("tasks", "create", "Stray"), {
    encoding: "utf8",
    env,
  });
  expect(status.status).not.toBe(0);
  expect(status.stderr).toContain("ENOTDIR");
}, 30_000);

it("runs the integration suite under the same setup and guard", () => {
  expect(integration.test?.globalSetup).toEqual([
    "test/helpers/migrations.ts",
    "test/helpers/setup.ts",
  ]);
  expect(integration.test?.setupFiles).toEqual(["test/helpers/guard.ts"]);
});
