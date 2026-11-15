import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { cliArgs } from "./helpers/cli";
import { testHome } from "./helpers/home";
import { markedProcesses, stopProcesses } from "./helpers/processes";
import { RUN_ENV, startRun, sweepFinishedRuns } from "./helpers/runs";
import { temporaryDirectory } from "./helpers/temporary";

/**
 * A Bun process that runs until it is stopped, carrying `env` and nothing
 * else; its pid once it is ready. Bun, not `/bin/sleep`: macOS shows no
 * one the environment of its own platform binaries.
 */
async function sleeper(
  env: Record<string, string>,
  { ignoreTerm = false, script = "" } = {}
): Promise<number> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `${ignoreTerm ? 'process.on("SIGTERM", () => undefined);' : ""}${script}
console.log("ready");
setInterval(() => undefined, 1000);`,
    ],
    { detached: true, env, stdio: ["ignore", "pipe", "inherit"] }
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

const gone = (pid: number) =>
  vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });

it("finds only the processes whose environment holds the whole marker", async () => {
  const marked = await sleeper({ PROBE_MARK: "/tmp/probe-a" });
  const longer = await sleeper({ PROBE_MARK: "/tmp/probe-ab" });
  const unmarked = await sleeper({ OTHER: "/tmp/probe-a" });
  try {
    expect(
      markedProcesses("PROBE_MARK", "/tmp/probe-a").map(({ pid }) => pid)
    ).toEqual([marked]);
  } finally {
    for (const pid of [marked, longer, unmarked]) {
      process.kill(pid, "SIGKILL");
    }
  }
});

it("stops a marked group leader with the unmarked children in its group", async () => {
  const dir = temporaryDirectory("marbles-group-");
  const reported = join(dir, "child");
  // The child gets no environment at all, as an MCP transport's might not.
  const leader = await sleeper(
    { PROBE_MARK: dir },
    {
      script: `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { env: {}, stdio: "ignore" });
require("node:fs").writeFileSync(${JSON.stringify(reported)}, String(child.pid));`,
    }
  );
  const child = Number(readFileSync(reported, "utf8"));
  expect(alive(child)).toBe(true);
  expect(markedProcesses("PROBE_MARK", dir)).toEqual([
    { pgid: leader, pid: leader },
  ]);
  expect(await stopProcesses(markedProcesses("PROBE_MARK", dir))).toEqual([]);
  await gone(child);
});

it("kills a marked process that ignores SIGTERM once the grace period ends", async () => {
  const pid = await sleeper(
    { PROBE_MARK: "/tmp/probe-stubborn" },
    { ignoreTerm: true }
  );
  const started = Date.now();
  const survivors = await stopProcesses(
    markedProcesses("PROBE_MARK", "/tmp/probe-stubborn"),
    { graceMs: 300, killMs: 2000 }
  );
  expect(survivors).toEqual([]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  await gone(pid);
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
import { startRun } from ${JSON.stringify(resolve("test/helpers/runs.ts"))};
const run = startRun(${JSON.stringify(parent)});
const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { detached: true, env: { ${RUN_ENV}: run.root }, stdio: "ignore" });
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

it("sweeps a killed run: stops what carries its marker and removes its root", async () => {
  const parent = temporaryDirectory("sw-");
  const { leftover, root } = await killedRun(parent);
  expect(alive(leftover)).toBe(true);
  await sweepFinishedRuns(parent);
  await gone(leftover);
  expect(existsSync(root)).toBe(false);
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
    await sweepFinishedRuns(parent);
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
    JSON.stringify({ pid: reused, started: "Thu Jan  1 00:00:00 1970" })
  );
  const leftover = await sleeper({ [RUN_ENV]: root });
  try {
    await sweepFinishedRuns(parent);
    await gone(leftover);
    expect(existsSync(root)).toBe(false);
    expect(alive(reused)).toBe(true);
  } finally {
    process.kill(reused, "SIGKILL");
  }
});

it("leaves a live run, roots that never named a readable owner, and unmarked processes alone", async () => {
  const parent = temporaryDirectory("sw-");
  const live = startRun(parent);
  const liveChild = await sleeper({ [RUN_ENV]: live.root });
  const silent = join(parent, "marbles-run-silent");
  mkdirSync(silent);
  const silentChild = await sleeper({ [RUN_ENV]: silent });
  const garbled = join(parent, "marbles-run-garbled");
  mkdirSync(garbled);
  writeFileSync(join(garbled, "owner.json"), '{"pid": 1');
  const killed = await killedRun(parent);
  const unmarked = await sleeper({ OTHER: killed.root });
  try {
    await sweepFinishedRuns(parent);
    expect(existsSync(killed.root)).toBe(false);
    await gone(killed.leftover);
    expect([live.root, silent, garbled].map(existsSync)).toEqual([
      true,
      true,
      true,
    ]);
    expect([liveChild, silentChild, unmarked].map(alive)).toEqual([
      true,
      true,
      true,
    ]);
  } finally {
    await live.finish();
    for (const pid of [silentChild, unmarked]) {
      process.kill(pid, "SIGKILL");
    }
  }
  await gone(liveChild);
  expect(existsSync(live.root)).toBe(false);
});

const left: { home?: string; pid?: number } = {};

it("starts the Marbles process in a home of the test's own", () => {
  const home = testHome();
  const source = join(home.path, "marbles.ts");
  writeFileSync(
    source,
    'import { step } from "@foundry.sh/marbles";\nstep("noop").do(() => "ok");\n'
  );
  const attached = spawnSync(
    "bun",
    [...cliArgs("attach", "--source", source)],
    {
      encoding: "utf8",
      env: home.env,
      timeout: 60_000,
    }
  );
  expect(attached.status, attached.stderr).toBe(0);
  const [daemon] = markedProcesses("FOUNDRY_HOME", home.path).filter(
    ({ pgid, pid }) => pgid === pid
  );
  expect(daemon).toBeDefined();
  left.home = home.path;
  left.pid = daemon?.pid;
}, 60_000);

it("stops that process and removes the home when the test finishes", () => {
  expect(left.pid).toBeDefined();
  expect(alive(left.pid ?? 0)).toBe(false);
  expect(existsSync(left.home ?? "")).toBe(false);
});

it("refuses a test process that would use the developer's home", () => {
  const {
    [RUN_ENV]: _run,
    FOUNDRY_HOME: _home,
    HOME: _user,
    ...env
  } = process.env;
  const refused = spawnSync("bun", [resolve("test/helpers/guard.ts")], {
    encoding: "utf8",
    env,
  });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("would use the developer's home");
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
