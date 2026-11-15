import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, it, vi } from "vitest";
import { recordSpawned, SPAWN_RECORD_ENV, startedAt } from "~/process/spawned";
import integration from "../vitest.integration.config";
import { cliArgs } from "./helpers/cli";
import { testHome } from "./helpers/home";
import { RecordedStdioTransport } from "./helpers/mcp-stdio";
import {
  type Marker,
  type ProcessSystem,
  recordProcess,
  stopRecorded,
  unrecordedMarked,
} from "./helpers/processes";
import {
  RUN_ENV,
  runRecords,
  startRun,
  sweepFinishedRuns,
} from "./helpers/runs";
import { temporaryDirectory } from "./helpers/temporary";

/** A marker no other test, run or suite on the machine carries. */
function uniqueMarker(): Marker {
  return { name: "MARBLES_TEST_PROBE", value: temporaryDirectory("mk-") };
}

const entry = (marker: Marker) => `${marker.name}=${marker.value}`;

/**
 * A Bun process that runs until it is stopped, carrying `env` and nothing
 * else; its pid once it is ready. In a process group of its own unless
 * `inGroup` is false.
 */
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
      // One line, as `ps` prints a command line on one.
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

it("records a process Marbles starts only where MARBLES_SPAWN_RECORD points", async () => {
  const records = temporaryDirectory("rec-");
  const pid = await sleeper({});
  try {
    recordSpawned(pid, true, {});
    expect(readdirSync(records)).toEqual([]);
    recordSpawned(pid, true, { [SPAWN_RECORD_ENV]: records });
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
    // Recorded, but its environment says it is not the run's: not signalled.
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
  writeFileSync(
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
    environment: () => [entry(marker)],
    kill(target, signal) {
      sent.push([target, signal]);
      // It exits, and the system gives its pid to another process.
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

it("does not signal a recorded process whose pid now names one that started later", async () => {
  const marker = uniqueMarker();
  const records = temporaryDirectory("rec-");
  const later = await sleeper({ [marker.name]: marker.value });
  writeFileSync(
    join(records, `${String(later)}.json`),
    JSON.stringify({
      group: true,
      pid: later,
      started: "Thu Jan 1 00:00:00 1970",
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
  // The leader exits on SIGTERM; its child ignores SIGTERM and has no record.
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
        `process ${String(child)} outlived the recorded leader`
      ),
    ]);
    expect(alive(child)).toBe(true);
    expect(existsSync(records)).toBe(true);
  } finally {
    kill(child);
  }
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

/** A run started in a child process, which is then killed outright. */
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
  mkdirSync(root);
  writeFileSync(
    join(root, "owner.json"),
    JSON.stringify({ pid: reused, started: "Thu Jan 1 00:00:00 1970" })
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

it("leaves a live run, roots that never named a readable owner, and their processes alone", async () => {
  const parent = temporaryDirectory("sw-");
  const live = startRun(parent, FAST);
  const liveChild = await sleeper({ [RUN_ENV]: live.root });
  recordProcess(join(live.records, "run"), liveChild, true);
  const silent = join(parent, "marbles-run-silent");
  mkdirSync(silent);
  const silentChild = await sleeper({ [RUN_ENV]: silent });
  recordProcess(join(runRecords(silent), "run"), silentChild, true);
  const garbled = join(parent, "marbles-run-garbled");
  mkdirSync(garbled);
  writeFileSync(join(garbled, "owner.json"), '{"pid": 1');
  const killed = await killedRun(parent);
  try {
    await sweepFinishedRuns(parent, FAST);
    expect(existsSync(killed.root)).toBe(false);
    await gone(killed.leftover);
    expect([live.root, silent, garbled].map(existsSync)).toEqual([
      true,
      true,
      true,
    ]);
    expect([liveChild, silentChild].map(alive)).toEqual([true, true]);
  } finally {
    await live.finish();
    kill(silentChild);
  }
  await gone(liveChild);
  expect(existsSync(live.root)).toBe(false);
});

const left: { home?: string; pid?: number } = {};

it("records the Marbles process a test's CLI starts in the test's home", () => {
  const home = testHome();
  const source = join(home.path, "marbles.ts");
  writeFileSync(
    source,
    'import { step } from "@foundry.sh/marbles";\nstep("noop").do(() => "ok");\n'
  );
  const attached = spawnSync("bun", cliArgs("attach", "--source", source), {
    encoding: "utf8",
    env: home.env,
    timeout: 60_000,
  });
  expect(attached.status, attached.stderr).toBe(0);
  const records = home.env[SPAWN_RECORD_ENV] ?? "";
  const recorded = readdirSync(records).map((name) =>
    JSON.parse(readFileSync(join(records, name), "utf8"))
  );
  // The daemon the CLI started, and the worker the daemon started.
  const daemon = recorded.find((record) => record.group === true);
  expect(daemon?.started).toBe(startedAt(daemon?.pid));
  expect(recorded.filter((record) => record.group === false)).toHaveLength(1);
  left.home = home.path;
  left.pid = daemon?.pid;
}, 60_000);

it("stops that process and removes the home when the test finishes", () => {
  expect(left.pid).toBeDefined();
  expect(alive(left.pid ?? 0)).toBe(false);
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
    // The relay this test started, and the server the relay started.
    expect(
      readdirSync(records).map((name) => Number(name.slice(0, -".json".length)))
    ).toEqual(expect.arrayContaining([transport.pid]));
    expect(readdirSync(records)).toHaveLength(2);
  } finally {
    await client.close();
  }
}, 30_000);

/** The guard, run as a test worker with `env`. */
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
});

it("judges the guard's paths with their links resolved", () => {
  const root = temporaryDirectory("gd-");
  const user = join(root, "user");
  mkdirSync(user);
  const outside = temporaryDirectory("gd-out-");
  symlinkSync(outside, join(root, "link"));
  // Inside the root as written, outside it once the link is resolved.
  const escaped = guard({
    ...process.env,
    FOUNDRY_HOME: join(root, "link", "home"),
    HOME: user,
    [RUN_ENV]: root,
  });
  expect(escaped.status).not.toBe(0);
  expect(escaped.stderr).toContain("would use the developer's home");
  // `/tmp` is a link to `/private/tmp` on macOS: either spelling passes.
  const other = root.startsWith("/private/")
    ? root.slice("/private".length)
    : `/private${root}`;
  const spelled = guard({
    ...process.env,
    FOUNDRY_HOME: join(root, "home"),
    HOME: user,
    [RUN_ENV]: other,
  });
  expect(spelled.status, spelled.stderr).toBe(0);
});

it("makes a process that lost FOUNDRY_HOME but kept HOME fail instead of using the default home", () => {
  const { FOUNDRY_HOME: _home, ...env } = process.env;
  const status = spawnSync("bun", cliArgs("tasks", "create", "Stray"), {
    encoding: "utf8",
    env,
  });
  expect(status.status).not.toBe(0);
  expect(status.stderr).toContain("ENOTDIR");
});

it("runs the integration suite under the same setup and guard", () => {
  expect(integration.test?.globalSetup).toEqual(["test/helpers/setup.ts"]);
  expect(integration.test?.setupFiles).toEqual(["test/helpers/guard.ts"]);
});
