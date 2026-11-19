import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sleep, spawn, spawnSync, stripANSI } from "bun";
import { expect, test } from "vitest";
import { DatabaseProviderStore } from "../src/database/providers";
import { marblesProviderConfigurations } from "../src/database/tables";
import { writeAsHost } from "../src/database/workspaces";
import { stateDatabase } from "../src/layout";
import { readProcess } from "../src/process/instance";
import { type TestHome, testHome } from "./helpers/home";
import { snapshotTrees } from "./helpers/tree-snapshot";

const ZOD = import.meta.resolve("zod");

const SCREEN_MS = 8000;
const STARTUP_MS = 30_000;

async function until(predicate: () => boolean, ms = SCREEN_MS) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Terminal did not reach the expected state");
    }
    await sleep(25);
  }
}

for (const command of [[], ["run"]]) {
  test(`real CLI ${command[0] ?? "without arguments"} gates startup and cancels a live run`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "marbles-terminal-"));
    const home = testHome();
    const config = join(dir, "marbles.config.ts");
    const started = join(dir, "started");
    const cancelled = join(dir, "cancelled");
    writeFileSync(
      config,
      `
      import { writeFileSync } from "node:fs";
      import { schedule, step } from "@foundry.sh/marbles";
      const wait = step("waiting-step").do(({ signal, log }) => new Promise(resolve => {
        writeFileSync(${JSON.stringify(started)}, "started");
        log("Waiting for cancellation");
        signal.addEventListener("abort", () => {
          writeFileSync(${JSON.stringify(cancelled)}, "cancelled");
          resolve(null);
        }, { once: true });
      }));
      schedule(wait).every("1s");
    `
    );
    let output = "";
    const child = spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        ...command,
        "--dry-run",
        "--config",
        config,
      ],
      {
        env: home.env,
        terminal: {
          cols: 120,
          data(_terminal, bytes) {
            output = (output + Buffer.from(bytes).toString()).slice(-100_000);
          },
          rows: 40,
        },
      }
    );
    home.track(child.pid, true);
    try {
      await until(() => output.includes("Press Enter to enter"));
      await sleep(1200);
      expect(existsSync(started)).toBe(false);
      child.terminal?.write("\r");
      await until(() => existsSync(started));
      await until(() => output.includes("waiting-step"));
      expect(output).toContain("Triggers");
      expect(output).toContain("2 Marbles");
      child.terminal?.write("q");
      await until(() => output.includes("Quit Marbles?"));
      await sleep(450);
      child.terminal?.write("\x03");
      await until(() => child.exitCode !== null);
      expect(await child.exited, stripANSI(output).slice(-8000)).toBe(0);
      expect(readFileSync(cancelled, "utf8")).toBe("cancelled");
    } finally {
      child.kill();
      await child.exited;
      child.terminal?.close();
      rmSync(dir, { force: true, recursive: true });
    }
  }, 15_000);
}

test("piped startup runs immediately and SIGTERM drains work with plain output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-piped-"));
  const home = testHome();
  const config = join(dir, "marbles.config.ts");
  const marker = join(dir, "ran");
  writeFileSync(
    config,
    `
    import { writeFileSync } from "node:fs";
    import { step, schedule } from "@foundry.sh/marbles";
    const task = step("plain-step").do(() => {
      writeFileSync(${JSON.stringify(marker)}, "ran");
      return "done";
    });
    schedule(task).every("1s");
  `
  );
  const child = spawn(
    [process.execPath, resolve("src/cli.ts"), "--dry-run", "--config", config],
    { env: home.env, stderr: "pipe", stdout: "pipe" }
  );
  home.track(child.pid, false);
  const output = new Response(child.stdout).text();
  try {
    await until(() => existsSync(marker));
    child.kill("SIGTERM");
    await until(() => child.exitCode !== null);
    expect(await child.exited).toBe(0);
    const text = await output;
    expect(text).toContain("[schedule] plain-step → plain-step");
    expect(text).toContain("[run] plain-step complete");
    expect(text).not.toContain("\x1b[");
    expect(text).not.toContain("Press Enter");
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { force: true, recursive: true });
  }
}, 12_000);

test("a config error restores the terminal and exits instead of leaving the splash open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-bad-config-"));
  const home = testHome();
  const config = join(dir, "marbles.config.ts");
  writeFileSync(config, 'throw new Error("test config could not load");');
  let output = "";
  const child = spawn(
    [process.execPath, resolve("src/cli.ts"), "--dry-run", "--config", config],
    {
      env: home.env,
      terminal: {
        cols: 100,
        data(_terminal, bytes) {
          output += Buffer.from(bytes).toString();
        },
        rows: 30,
      },
    }
  );
  home.track(child.pid, true);
  try {
    await until(() => output.includes("Marbles could not load"));
    child.terminal?.write("\r");
    await until(() => child.exitCode !== null);
    expect(await child.exited).not.toBe(0);
    expect(output).toContain("test config could not load");
    expect(output).toContain("\x1b[?1049l");
  } finally {
    child.kill();
    await child.exited;
    child.terminal?.close();
    rmSync(dir, { force: true, recursive: true });
  }
}, 12_000);

async function openTestCli(
  home: TestHome,
  config: string,
  flags: readonly string[] = ["--dry-run"],
  cwd?: string,
  detectCodex = true
) {
  const bin = join(dirname(config), "test-bin");
  if (detectCodex) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "codex"), 0o755);
  }
  let output = "";
  const child = spawn(
    [process.execPath, resolve("src/cli.ts"), ...flags, "--config", config],
    {
      cwd,
      env: {
        ...home.env,
        PATH: detectCodex ? `${bin}:${home.env.PATH}` : "/usr/bin:/bin",
      },
      terminal: {
        cols: 100,
        data(_terminal, bytes) {
          output += Buffer.from(bytes).toString();
        },
        rows: 40,
      },
    }
  );
  home.track(child.pid, true);
  return {
    child,
    async dispose() {
      child.kill();
      await child.exited;
      child.terminal?.close();
    },
    mark: () => output.length,
    output: () => stripANSI(output),
    async see(value: string, from = 0, ms = SCREEN_MS) {
      try {
        await until(() => output.includes(value, from), ms);
      } catch (cause) {
        throw new Error(
          `Terminal did not show ${JSON.stringify(value)} (exit ${child.exitCode}). Output:\n${stripANSI(output).slice(-8000)}`,
          { cause }
        );
      }
    },
    async send(value: string) {
      child.terminal?.write(value);
      await sleep(75);
    },
  };
}

test("first-run provider setup precedes workspace setup, preserves dry runs, and can be skipped", async () => {
  const dir = mkdtempSync("/tmp/mb-providers-");
  const home = testHome({ providers: false });
  const config = join(dir, ".foundry", "marbles");
  const { state } = home.layout;
  const machine = async () =>
    (await DatabaseProviderStore.forState(state).read()).machine;
  const dry = await openTestCli(home, config, ["--dry-run"]);
  try {
    await dry.see("Press Enter to enter");
    expect(await machine()).toBeUndefined();
  } finally {
    await dry.dispose();
  }
  const live = await openTestCli(home, config, [], dir);
  try {
    await live.see("Set up model providers");
    await live.see("Codex");
    await live.see(dir);
    expect(live.output()).not.toContain("Choose a starter");
    await live.send("\x1b");
    await live.see("Choose a starter", 0, STARTUP_MS);
    expect(await machine()).toBeUndefined();
  } finally {
    await live.dispose();
  }
  await writeAsHost(state, (database) =>
    database
      .insert(marblesProviderConfigurations)
      .values({ configuration: "{ broken", revision: 1, scope: "" })
  );
  const broken = await openTestCli(home, config, []);
  try {
    await broken.see("provider configuration cannot be read");
    await broken.child.exited;
    expect(broken.child.exitCode).toBe(1);
    expect(broken.output()).toContain("marbles: ");
    expect(broken.output()).not.toContain("    at ");
  } finally {
    await broken.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
}, 30_000);

test("a corrupt settings file lets an unconfigured terminal continue and reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-corrupt-settings-"));
  const home = testHome({ providers: false });
  const { state } = home.layout;
  const settings = join(state, "settings.json");
  const config = join(dir, "marbles.config.ts");
  mkdirSync(state, { recursive: true });
  writeFileSync(settings, "{not json");
  writeFileSync(config, "export {};");

  try {
    const first = await openTestCli(home, config, [], dir, false);
    try {
      await first.see("No machine-wide providers are available");
      await first.send("\r");
      await first.see("Open this workspace");
      await first.send("\r");
      await first.see("Press Enter to enter", 0, STARTUP_MS);
      await first.send("\r");
      await first.see("Dashboard");
      await first.send("q");
      await first.see("Quit Marbles?");
      await first.send("\x1b");
      await first.send("S");
      await first.see("is not valid JSON");
    } finally {
      await first.dispose();
    }

    const reopened = await openTestCli(home, config, [], dir, false);
    try {
      await reopened.see("Press Enter to enter", 0, STARTUP_MS);
      expect(reopened.output()).not.toContain("Set up model providers");
      expect(readFileSync(settings, "utf8")).toBe("{not json");
    } finally {
      await reopened.dispose();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}, 75_000);

test("an initialized machine welcomes a new workspace and can recheck providers without replacing them", async () => {
  const dir = mkdtempSync("/tmp/mb-onboarding-");
  const config = join(dir, "marbles.config.ts");
  writeFileSync(config, "export {};");
  const home = testHome();
  const store = DatabaseProviderStore.forState(home.layout.state);
  const before = (await store.read()).machine;
  const first = await openTestCli(home, config, []);
  try {
    await first.see("Open this workspace", 0, STARTUP_MS);
    await first.see(config);
    expect(first.output()).not.toContain("Set up model providers");
    await first.send("\r");
    await first.see("Press Enter to enter", 0, STARTUP_MS);
  } finally {
    await first.dispose();
  }
  const next = await openTestCli(home, config, ["--recheck-providers"]);
  try {
    await next.see("Set up model providers");
    await next.see("already configured");
    await next.send("\r");
    await next.see("Press Enter to enter", 0, STARTUP_MS);
    expect(next.output()).not.toContain("Open this workspace");
    expect((await store.read()).machine).toEqual(before);
  } finally {
    await next.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
}, 60_000);

test("a dry run with no authoring folder offers no starter, writes nothing, and says to run marbles init", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-setup-"));
  const home = testHome();
  const config = join(dir, ".foundry", "marbles");
  const bin = join(dir, ".foundry", "test-bin");
  mkdirSync(bin, { recursive: true });
  const ignored = new Set([bin, `${stateDatabase(home.layout.state)}-shm`]);
  const before = snapshotTrees([dir, home.path], ignored);
  const terminal = await openTestCli(home, config);
  try {
    await terminal.see("Press Enter to enter");
    await terminal.send("\r");
    await terminal.see("marbles init without --dry-run");
    expect(terminal.output()).not.toContain("Set up your workspace");
    await terminal.send("q");
    await terminal.see("Quit Marbles?");
    await terminal.send("\x03");
    await until(() => terminal.child.exitCode !== null);
    expect(snapshotTrees([dir, home.path], ignored)).toEqual(before);
  } finally {
    await terminal.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
}, 15_000);

test("a missing authoring folder onboards against the Marbles process, which posts the milestone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-"));
  const home = testHome();
  const config = join(dir, ".foundry", "marbles");
  const file = join(config, "summarize-codebase.ts");
  const terminal = await openTestCli(home, config, ["run"]);
  try {
    await terminal.see("Choose a starter", 0, STARTUP_MS);
    expect(existsSync(config)).toBe(false);
    await terminal.send("\r");
    await terminal.see("Step name");
    await terminal.send("\t");
    await terminal.send("\t");
    await terminal.send("\r");
    await terminal.see("summarizeCodebase");
    expect(existsSync(config)).toBe(false);
    await terminal.send("\r");
    await terminal.see("Press Enter to enter", 0, STARTUP_MS);
    expect(readFileSync(file, "utf8")).toContain(
      "@foundry.sh/marbles/prebuilt"
    );
    await terminal.send("\r");
    await terminal.see("Dashboard");
    await terminal.send("C");
    await terminal.see("2 Marbles");
    await terminal.send("F");
    await terminal.see("Workspace set up");
    await terminal.send("q");
    await terminal.see("Quit Marbles?");
    await terminal.send("\x03");
    await until(() => terminal.child.exitCode !== null);
    expect(await terminal.child.exited).toBe(0);
  } finally {
    await terminal.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
}, 90_000);

test("setup skip leaves the config absent and opens the empty dashboard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-"));
  const config = join(dir, "marbles.config.ts");
  const terminal = await openTestCli(testHome(), config, ["run"]);
  try {
    await terminal.see("Choose a starter", 0, STARTUP_MS);
    await terminal.send("\x1b");
    await terminal.see("setup skipped");
    await terminal.send("\r");
    await terminal.see("Dashboard", 0, STARTUP_MS);
    await terminal.send("C");
    await terminal.see("No workflows or steps.");
    expect(existsSync(config)).toBe(false);
    await terminal.send("q");
    await terminal.see("Quit Marbles?");
    await terminal.send("\x03");
    await until(() => terminal.child.exitCode !== null);
    expect(await terminal.child.exited).toBe(0);
  } finally {
    await terminal.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
}, 15_000);

test("manual workflow launch uses typed arguments while scheduled runs continue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-launch-"));
  const config = join(dir, "marbles.config.ts");
  const marker = join(dir, "manual.json");
  const ticks = join(dir, "ticks");
  writeFileSync(
    config,
    `
import { writeFileSync, appendFileSync } from "node:fs";
import { step, workflow, schedule } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(ZOD)};
const tick = step("tick").do(() => { appendFileSync(${JSON.stringify(ticks)}, "tick\\n"); });
schedule(tick).every("1s");
const message = z.object({ message: z.string(), enabled: z.boolean().default(false), count: z.number().default(0) });
const echo = step("echo").input(message).do(({ input }) => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(input)); return input; });
workflow("manual").input(message).do(({ input }) => echo({}, input));
`
  );
  const terminal = await openTestCli(testHome(), config);
  try {
    await terminal.see("Press Enter to enter");
    await terminal.send("\r");
    await until(() => existsSync(ticks));
    const before = readFileSync(ticks, "utf8").length;
    await terminal.send("2");
    await terminal.send("\x1b[B");
    await terminal.send("\x1b[B");
    await terminal.send("\r");
    await terminal.send("l");
    await terminal.see("Launch manual");
    await terminal.send("hello");
    await terminal.send("\t");
    await terminal.send("\t");
    await terminal.send("\t");
    await terminal.send("\r");
    await until(() => existsSync(marker));
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      count: 0,
      enabled: false,
      message: "hello",
    });
    await until(() => readFileSync(ticks, "utf8").length > before);
    await terminal.see("3 Runs");
    await terminal.send("q");
    await terminal.see("Quit Marbles?");
    await terminal.send("\x03");
    await until(() => terminal.child.exitCode !== null);
    expect(await terminal.child.exited).toBe(0);
  } finally {
    await terminal.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
}, 15_000);

test("the dashboard attaches to the Marbles process, which keeps hosting after it quits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-"));
  const home = testHome();
  const { state } = home.layout;
  const config = join(dir, "marbles.config.ts");
  const ticks = join(dir, "ticks");
  writeFileSync(
    config,
    `
    import { appendFileSync } from "node:fs";
    import { schedule, step } from "@foundry.sh/marbles";
    const tick = step("remote-step").do(() => {
      appendFileSync(${JSON.stringify(ticks)}, "tick\\n");
      return "ticked";
    });
    schedule(tick).every("1s");
  `
  );
  const tickCount = () =>
    existsSync(ticks) ? readFileSync(ticks, "utf8").length : 0;
  const terminal = await openTestCli(home, config, ["run"]);
  try {
    await terminal.see("Open this workspace", 0, STARTUP_MS);
    await terminal.send("\r");
    await terminal.see("Press Enter to enter", 0, STARTUP_MS);
    expect(readProcess(state)?.host).toBe("daemon");
    await terminal.send("\r");
    await terminal.see("remote-step");
    await terminal.see("Dashboard");
    await until(() => tickCount() > 0);
    const other = join(dir, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "marbles.config.ts"),
      'import { step } from "@foundry.sh/marbles";\nstep("other-step").do(() => "other");\n'
    );
    const follower = spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "run",
        "--config",
        join(other, "marbles.config.ts"),
      ],
      { env: home.env, stderr: "pipe", stdout: "pipe" }
    );
    home.track(follower.pid, false);
    try {
      await terminal.see("w Workspaces");
      const picker = terminal.mark();
      await terminal.send("w");
      await terminal.see("other", picker);
      await terminal.send("\x1b[B");
      await terminal.send("\r");
      await terminal.send("C");
      await terminal.see("other-step", picker);
      const back = terminal.mark();
      await terminal.send("w");
      await terminal.send("\x1b[B");
      await terminal.send("\r");
      await terminal.see("remote-step", back);
    } finally {
      follower.kill("SIGTERM");
      await follower.exited;
    }
    await terminal.send("q");
    await terminal.see("Quit Marbles?");
    await terminal.see("Triggers keep running in the Marbles");
    await terminal.send("\x03");
    await until(() => terminal.child.exitCode !== null);
    expect(await terminal.child.exited).toBe(0);
    expect(readProcess(state)?.alive).toBe(true);
    const before = tickCount();
    await until(() => tickCount() > before);
  } finally {
    await terminal.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
}, 60_000);

test("a command line that cannot run prints usage and touches nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-usage-"));
  const home = testHome({ providers: false });
  const config = join(dir, "marbles.config.ts");
  const imported = join(dir, "imported");
  const { state } = home.layout;
  writeFileSync(
    config,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(imported)}, "imported");`
  );
  try {
    for (const command of [
      ["bogus"],
      ["roll"],
      ["list", "--harness", "foo"],
      ["launchd", "install", "ping"],
      ["launchd", "uninstall", "ping"],
    ]) {
      const child = spawnSync(
        [
          process.execPath,
          resolve("src/cli.ts"),
          ...command,
          "--config",
          config,
        ],
        { env: home.env, stderr: "pipe", stdout: "pipe" }
      );
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain(
        "programmable workspace automation"
      );
      expect(existsSync(imported)).toBe(false);
      expect(existsSync(state)).toBe(false);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}, 15_000);

test("roll explains bad input and an unanswerable ask in one line", () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-roll-errors-"));
  const home = testHome();
  const config = join(dir, "marbles.config.ts");
  writeFileSync(
    config,
    `import { schedule, step } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(ZOD)};
const greet = step("greet").input(z.object({ name: z.string() })).do(({ input }) => input.name);
step("asks").do(({ ask }) => ask.question({ title: "Name?" }));
schedule(greet({}, { name: "Ada" })).every("1h");`
  );
  const roll = (...args: string[]) =>
    spawnSync(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "roll",
        ...args,
        "--dry-run",
        "--config",
        config,
      ],
      { env: home.env, stderr: "pipe", stdout: "pipe" }
    );
  try {
    const missing = roll("greet");
    expect(missing.exitCode).toBe(1);
    const said = missing.stderr.toString();
    expect(said).toContain(`marbles: "greet" input: name:`);
    expect(said).toContain(`Pass --input '{"name":"…"}'`);
    expect(said).toContain("roll a schedule key that carries it: greet-");
    expect(said).not.toContain("    at ");

    const malformed = roll("greet", "--input", "{bad");
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr.toString()).toContain(
      "marbles: --input is not JSON"
    );

    const asks = roll("asks");
    expect(asks.exitCode).toBe(1);
    expect(asks.stderr.toString()).toContain(
      `marbles: run "asks" was cancelled: "Name?" is waiting for an answer`
    );
    expect(asks.stderr.toString()).not.toContain("    at ");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}, 15_000);
