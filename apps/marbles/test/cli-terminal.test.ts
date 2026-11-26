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
import { sleep, spawn, spawnSync } from "bun";
import { expect, test } from "vitest";
import { DatabaseProviderStore } from "../src/database/providers";
import { marblesProviderConfigurations } from "../src/database/tables";
import { writeAsHost } from "../src/database/workspaces";
import { readProcess } from "../src/process/instance";
import { type TestHome, testHome } from "./helpers/home";
import { openTerminal } from "./helpers/screen";

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

test("piped startup attaches to the Marbles process and SIGTERM detaches cleanly with plain output", async () => {
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
    [process.execPath, resolve("src/cli.ts"), "--source", config],
    { env: home.env, stderr: "pipe", stdout: "pipe" }
  );
  home.track(child.pid, false);
  const output = new Response(child.stdout).text();
  try {
    await until(() => existsSync(marker), STARTUP_MS);
    child.kill("SIGTERM");
    await until(() => child.exitCode !== null);
    expect(await child.exited).toBe(0);
    const text = await output;
    expect(text).toContain("[process] pid");
    expect(text).not.toContain("\x1b[");
    expect(text).not.toContain("Press Enter");
  } finally {
    child.kill();
    await child.exited;
    rmSync(dir, { force: true, recursive: true });
  }
}, 60_000);

function openTestCli(
  home: TestHome,
  config: string,
  flags: readonly string[] = [],
  cwd?: string,
  detectCodex = true
) {
  const bin = join(dirname(config), "test-bin");
  if (detectCodex) {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "codex"), 0o755);
  }
  return openTerminal(
    home,
    [process.execPath, resolve("src/cli.ts"), ...flags, "--source", config],
    {
      cols: 100,
      cwd,
      env: {
        ...home.env,
        PATH: detectCodex ? `${bin}:${home.env.PATH}` : "/usr/bin:/bin",
      },
      rows: 40,
    }
  );
}

test("first-run provider setup precedes workspace setup and can be skipped", async () => {
  const dir = mkdtempSync("/tmp/mb-providers-");
  const home = testHome({ providers: false });
  const config = join(dir, ".foundry", "marbles");
  const { state } = home.layout;
  const machine = async () =>
    (await DatabaseProviderStore.forState(state).read()).machine;
  const live = openTestCli(home, config, [], dir);
  try {
    await live.see("Set up model providers");
    await live.see("Codex");
    await live.see(dir);
    expect(await live.emitted("Choose a starter")).toBe(false);
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
  const broken = openTestCli(home, config, []);
  try {
    await broken.see("provider configuration cannot be read");
    await broken.child.exited;
    expect(broken.child.exitCode).toBe(1);
    expect(await broken.shown("marbles: ")).toBe(true);
    expect(await broken.emitted("    at ")).toBe(false);
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
    const first = openTestCli(home, config, [], dir, false);
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

    const reopened = openTestCli(home, config, [], dir, false);
    try {
      await reopened.see("Press Enter to enter", 0, STARTUP_MS);
      expect(await reopened.emitted("Set up model providers")).toBe(false);
      expect(readFileSync(settings, "utf8")).toBe("{not json");
    } finally {
      await reopened.dispose();
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}, 75_000);

test("an initialized machine welcomes a new workspace without re-running provider setup", async () => {
  const dir = mkdtempSync("/tmp/mb-onboarding-");
  const config = join(dir, "marbles.config.ts");
  writeFileSync(config, "export {};");
  const home = testHome();
  const first = openTestCli(home, config, []);
  try {
    await first.see("Open this workspace", 0, STARTUP_MS);
    await first.see(config);
    expect(await first.emitted("Set up model providers")).toBe(false);
    await first.send("\r");
    await first.see("Press Enter to enter", 0, STARTUP_MS);
  } finally {
    await first.dispose();
    rmSync(dir, { force: true, recursive: true });
  }
}, 60_000);

test("a missing authoring folder onboards against the Marbles process, which posts the milestone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-"));
  const home = testHome();
  const config = join(dir, ".foundry", "marbles");
  const file = join(config, "summarize-codebase.ts");
  const terminal = openTestCli(home, config, []);
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
  const terminal = openTestCli(testHome(), config, []);
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
  const terminal = openTestCli(testHome(), config, []);
  try {
    await terminal.see("Open this workspace", 0, STARTUP_MS);
    await terminal.send("\r");
    await terminal.see("Press Enter to enter", 0, STARTUP_MS);
    await terminal.send("\r");
    await until(() => existsSync(ticks), STARTUP_MS);
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
    await until(() => existsSync(marker), STARTUP_MS);
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
}, 60_000);

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
  const terminal = openTestCli(home, config, []);
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
        "--source",
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

test("on a terminal, run <name> runs it in the Marbles process and exits, and never opens the dashboard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-"));
  const config = join(dir, "marbles.config.ts");
  writeFileSync(
    config,
    'import { step } from "@foundry.sh/marbles";\nstep("hello-now").do(() => ({ said: "hello" }));\n'
  );
  const terminal = openTestCli(testHome(), config, ["run", "hello-now"]);
  try {
    await terminal.see('"said": "hello"', 0, STARTUP_MS);
    await until(() => terminal.child.exitCode !== null);
    expect(await terminal.child.exited).toBe(0);
    expect(await terminal.emitted("Dashboard")).toBe(false);
    expect(await terminal.emitted("Press Enter to enter")).toBe(false);
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
      ["run"],
      ["roll", "greet"],
      ["daemon"],
      ["daemon", "stop"],
      ["settings", "themes"],
      ["list", "--harness", "foo"],
      ["launchd", "install", "ping"],
      ["launchd", "uninstall", "ping"],
    ]) {
      const child = spawnSync(
        [
          process.execPath,
          resolve("src/cli.ts"),
          ...command,
          "--source",
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

test("run explains bad input in one line", () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-run-errors-"));
  const home = testHome();
  const config = join(dir, "marbles.config.ts");
  writeFileSync(
    config,
    `import { schedule, step } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(ZOD)};
const greet = step("greet").input(z.object({ name: z.string() })).do(({ input }) => input.name);
schedule(greet({}, { name: "Ada" })).every("1h");`
  );
  const runNow = (...args: string[]) =>
    spawnSync(
      [
        process.execPath,
        resolve("src/cli.ts"),
        "run",
        ...args,
        "--source",
        config,
      ],
      { env: home.env, stderr: "pipe", stdout: "pipe" }
    );
  try {
    const missing = runNow("greet");
    expect(missing.exitCode).toBe(1);
    const said = missing.stderr.toString();
    expect(said).toContain(`marbles: "greet" input: name:`);
    expect(said).toContain(`Pass --input '{"name":"…"}'`);
    expect(said).toContain("run a schedule key that carries it: greet-");
    expect(said).not.toContain("    at ");

    const malformed = runNow("greet", "--input", "{bad");
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr.toString()).toContain(
      "marbles: --input is not JSON"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}, 60_000);
