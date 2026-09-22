import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sleep, spawn } from "bun";

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
    const dir = mkdtempSync(join(tmpdir(), "quirks-terminal-"));
    const config = join(dir, "quirks.config.ts");
    const started = join(dir, "started");
    const cancelled = join(dir, "cancelled");
    writeFileSync(
      config,
      `
      import { writeFileSync } from "node:fs";
      import { schedule, step } from "@foundry/quirks";
      const wait = step("waiting-step", ({ signal, log }) => new Promise(resolve => {
        writeFileSync(${JSON.stringify(started)}, "started");
        log("Waiting for cancellation");
        signal.addEventListener("abort", () => {
          writeFileSync(${JSON.stringify(cancelled)}, "cancelled");
          resolve(null);
        }, { once: true });
      }));
      schedule("test-trigger", { workflow: wait, input: null, at: "1s" });
    `
    );
    let output = "";
    const child = spawn(
      [
        process.execPath,
        resolve("src/cli.ts"),
        ...command,
        "--dry",
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
      expect(output).toContain("Catalog");
      child.terminal?.write("q");
      await until(() => output.includes("Quit Quirks?"));
      await sleep(450); // Live refreshes must preserve the open dialog.
      child.terminal?.write("\x03");
      await until(() => child.exitCode !== null);
      expect(await child.exited).toBe(0);
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
  const dir = mkdtempSync(join(tmpdir(), "quirks-piped-"));
  const config = join(dir, "quirks.config.ts");
  const marker = join(dir, "ran");
  writeFileSync(
    config,
    `
    import { writeFileSync } from "node:fs";
    import { step, schedule } from "@foundry/quirks";
    const task = step("plain-step", async () => {
      writeFileSync(${JSON.stringify(marker)}, "ran");
      return "done";
    });
    schedule("plain-trigger", { workflow: task, input: null, at: "1s" });
  `
  );
  const child = spawn(
    [process.execPath, resolve("src/cli.ts"), "--dry", "--config", config],
    { stderr: "pipe", stdout: "pipe" }
  );
  const output = new Response(child.stdout).text();
  try {
    await until(() => existsSync(marker));
    child.kill("SIGTERM");
    await until(() => child.exitCode !== null);
    expect(await child.exited).toBe(0);
    const text = await output;
    expect(text).toContain("[schedule] plain-trigger");
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
  const dir = mkdtempSync(join(tmpdir(), "quirks-bad-config-"));
  const config = join(dir, "quirks.config.ts");
  writeFileSync(config, 'throw new Error("test config could not load");');
  let output = "";
  const child = spawn(
    [process.execPath, resolve("src/cli.ts"), "--dry", "--config", config],
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
