import { expect, test } from "bun:test";
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
import { sleep, spawn, stripANSI } from "bun";

/** Configs live in a tmpdir with no node_modules, so zod is imported by URL. */
const ZOD = import.meta.resolve("zod");

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 8000;
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
    const config = join(dir, "marbles.config.ts");
    const started = join(dir, "started");
    const cancelled = join(dir, "cancelled");
    writeFileSync(
      config,
      `
      import { writeFileSync } from "node:fs";
      import { schedule, step } from "@foundry/marbles";
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
        terminal: {
          cols: 120,
          data(_terminal, bytes) {
            output = (output + Buffer.from(bytes).toString()).slice(-100_000);
          },
          rows: 40,
        },
      }
    );
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
      await sleep(450); // Live refreshes must preserve the open dialog.
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
  const config = join(dir, "marbles.config.ts");
  const marker = join(dir, "ran");
  writeFileSync(
    config,
    `
    import { writeFileSync } from "node:fs";
    import { step, schedule } from "@foundry/marbles";
    const task = step("plain-step").do(() => {
      writeFileSync(${JSON.stringify(marker)}, "ran");
      return "done";
    });
    schedule(task).every("1s");
  `
  );
  const child = spawn(
    [process.execPath, resolve("src/cli.ts"), "--dry-run", "--config", config],
    { stderr: "pipe", stdout: "pipe" }
  );
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
  const config = join(dir, "marbles.config.ts");
  writeFileSync(config, 'throw new Error("test config could not load");');
  let output = "";
  const child = spawn(
    [process.execPath, resolve("src/cli.ts"), "--dry-run", "--config", config],
    {
      terminal: {
        cols: 100,
        data(_terminal, bytes) {
          output += Buffer.from(bytes).toString();
        },
        rows: 30,
      },
    }
  );
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

async function openTestCli(config: string) {
  const bin = join(dirname(config), "test-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "codex"), 0o755);
  let output = "";
  const child = spawn(
    [process.execPath, resolve("src/cli.ts"), "--dry-run", "--config", config],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      terminal: {
        cols: 100,
        data(_terminal, bytes) {
          output += Buffer.from(bytes).toString();
        },
        rows: 40,
      },
    }
  );
  return {
    child,
    async dispose() {
      child.kill();
      await child.exited;
      child.terminal?.close();
    },
    async see(value: string) {
      try {
        await until(() => output.includes(value));
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

test("missing authoring folder creates a Product starter without executing it, then launches from Marbles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-setup-"));
  const config = join(dir, ".foundry", "marbles");
  const file = join(config, "summarize-codebase.ts");
  const terminal = await openTestCli(config);
  try {
    await terminal.see("Choose a starter");
    expect(existsSync(config)).toBe(false);
    await terminal.send("\r");
    await terminal.see("Step name");
    await terminal.send("\t");
    await terminal.send("\t");
    await terminal.send("\t");
    await terminal.send("\r");
    await terminal.see("summarizeCodebase");
    expect(existsSync(config)).toBe(false);
    await terminal.send("\r");
    await terminal.see("Press Enter to enter");
    expect(readFileSync(file, "utf8")).toContain("@foundry/marbles/prebuilt");
    await terminal.send("\r");
    await terminal.see("2 Marbles");
    await terminal.send("2");
    await terminal.send("l");
    await terminal.see("complete");
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

test("setup skip leaves the config absent and opens the empty dashboard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marbles-skip-"));
  const config = join(dir, "marbles.config.ts");
  const terminal = await openTestCli(config);
  try {
    await terminal.see("Choose a starter");
    await terminal.send("\x1b");
    await terminal.see("setup skipped");
    await terminal.send("\r");
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
import { step, workflow, schedule } from "@foundry/marbles";
import { z } from ${JSON.stringify(ZOD)};
const tick = step("tick").do(() => { appendFileSync(${JSON.stringify(ticks)}, "tick\\n"); });
schedule(tick).every("1s");
const message = z.object({ message: z.string(), enabled: z.boolean().default(false), count: z.number().default(0) });
const echo = step("echo").input(message).do(({ input }) => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify(input)); return input; });
workflow("manual").input(message).do(({ input }) => echo({}, input));
`
  );
  const terminal = await openTestCli(config);
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
