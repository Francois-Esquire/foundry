import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cliArgs } from "./helpers/cli";
import { type TestHome, testHome } from "./helpers/home";
import { temporaryDirectory } from "./helpers/temporary";

const RUN_ID = /^rn-\S+$/;

function marblesIn(home: TestHome, root: string, source: string) {
  return (...args: string[]) =>
    spawnSync("bun", cliArgs(...args, "--source", source), {
      cwd: root,
      encoding: "utf8",
      env: home.env,
      input: "",
      timeout: 60_000,
    });
}

function workspace(source: string) {
  const root = temporaryDirectory("marbles-enqueue-");
  const file = join(root, "marbles.ts");
  writeFileSync(file, source);
  return { file, root };
}

describe("marbles trigger --async", { timeout: 120_000 }, () => {
  it("prints only the run's ID on stdout and exits while it waits, and watch follows it from the queue to its end", async () => {
    const home = testHome();
    const gate = join(temporaryDirectory("marbles-gate-"), "open");
    const { file, root } = workspace(`import { existsSync } from "node:fs";
import { defineConfig, step } from "@foundry.sh/marbles";
export default defineConfig({ pools: { default: 1 } });
export const blocker = step("blocker").do(async () => {
  while (!existsSync(${JSON.stringify(gate)})) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "unblocked";
});
export const echo = step("echo").do(({ input }) => input);
`);
    const marbles = marblesIn(home, root, file);

    const blocker = marbles("trigger", "blocker", "--async");
    expect(blocker.status, blocker.stderr).toBe(0);
    expect(blocker.stdout.trim()).toMatch(RUN_ID);
    expect(blocker.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(blocker.stderr).toContain(
      `marbles watch ${blocker.stdout.trim()} follows it`
    );

    const queued = marbles(
      "trigger",
      "echo",
      "--async",
      "--input",
      '{"word":"hi"}'
    );
    expect(queued.status, queued.stderr).toBe(0);
    const id = queued.stdout.trim();
    expect(id).toMatch(RUN_ID);
    expect(id).not.toBe(blocker.stdout.trim());

    const watcher = spawn("bun", cliArgs("watch", id), {
      cwd: root,
      env: home.env,
    });
    home.track(watcher.pid, false);
    let watched = "";
    watcher.stdout.on("data", (chunk: Buffer) => {
      watched += chunk.toString();
    });
    const exited = new Promise<number | null>((settle) =>
      watcher.on("exit", settle)
    );
    try {
      await vi.waitFor(
        () => expect(watched).toContain(`[run] ${id} waits in its queue`),
        { interval: 100, timeout: 30_000 }
      );
    } finally {
      writeFileSync(gate, "open");
    }
    expect(await exited).toBe(0);
    expect(watched).toContain("word: 'hi'");
    expect(watched).toContain(`[run] ${id} completed`);
  });

  it("enqueues once per --key, sharing the key with step.enqueue in the source", () => {
    const home = testHome();
    const { file, root } =
      workspace(`import { step } from "@foundry.sh/marbles";
export const keyed = step("keyed").do(() => "keyed done");
export const dispatcher = step("dispatcher").do(async () => {
  const run = await step.enqueue("keyed", {}, { key: "shared" });
  return run.id;
});
`);
    const marbles = marblesIn(home, root, file);

    const first = marbles("trigger", "keyed", "--async", "--key", "shared");
    expect(first.status, first.stderr).toBe(0);
    const id = first.stdout.trim();
    expect(id).toMatch(RUN_ID);
    expect(
      marbles("trigger", "--async", "--key", "shared", "keyed").stdout.trim()
    ).toBe(id);
    const fromSource = marbles("trigger", "dispatcher");
    expect(fromSource.status, fromSource.stderr).toBe(0);
    expect(fromSource.stdout).toContain(JSON.stringify(id));
    const other = marbles("trigger", "keyed", "--async", "--key", "other");
    expect(other.stdout.trim()).toMatch(RUN_ID);
    expect(other.stdout.trim()).not.toBe(id);
    const unkeyed = marbles("trigger", "keyed", "--async");
    expect(unkeyed.stdout.trim()).not.toBe(id);
  });

  it("refuses a name the workspace does not declare and a blank key, and supports --json", () => {
    const home = testHome();
    const { file, root } =
      workspace(`import { step } from "@foundry.sh/marbles";
export const keyed = step("keyed").do(() => "keyed done");
`);
    const marbles = marblesIn(home, root, file);
    const missing = marbles("trigger", "nothing-here", "--async");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain(
      'no workflow or step named "nothing-here"'
    );
    const blank = marbles("trigger", "keyed", "--async", "--key", "");
    expect(blank.status).toBe(1);
    expect(blank.stdout).toBe("");
    expect(blank.stderr).toContain(
      "trigger: --key takes a key that is not blank"
    );
    const json = marbles("trigger", "keyed", "--async", "--json");
    expect(json.status, json.stderr).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toMatchObject({
      name: "keyed",
      runId: expect.stringMatching(RUN_ID),
    });
  });
});

describe("marbles trigger <name>", { timeout: 120_000 }, () => {
  it("runs a step, a workflow, a schedule and a monitor by name, waiting for each", () => {
    const home = testHome();
    const marker = join(temporaryDirectory("marbles-monitor-"), "ran");
    const { file, root } = workspace(`import { writeFileSync } from "node:fs";
import { monitor, schedule, step, workflow } from "@foundry.sh/marbles";
export const leaf = step("leaf").do(() => ({ kind: "step" }));
export const flow = workflow("flow").do(() => leaf({}));
export const nightly = step("nightly").do(() => ({ kind: "schedule" }));
export const nightlySchedule = schedule(nightly).every("1h");
export const watcher = monitor("watched/**").name("watcher").every("1h").do(() => {
  writeFileSync(${JSON.stringify(marker)}, "ran");
});
`);
    mkdirSync(join(root, "watched"));
    writeFileSync(join(root, "watched", "note.txt"), "changed");
    const marbles = marblesIn(home, root, file);
    for (const [name, said] of [
      ["leaf", '"kind": "step"'],
      ["flow", '"kind": "step"'],
      ["nightly", '"kind": "schedule"'],
    ] as const) {
      const ran = marbles("trigger", name);
      expect(ran.status, `${name}: ${ran.stderr}`).toBe(0);
      expect(ran.stdout, name).toContain(said);
    }
    const json = marbles("trigger", "leaf", "--json");
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      name: "leaf",
      value: { kind: "step" },
    });
    const watched = marbles("trigger", "watcher");
    expect(watched.status, watched.stderr).toBe(0);
    expect(watched.stdout).toContain('"changed": true');
    expect(existsSync(marker)).toBe(true);
    const missing = marbles("trigger", "nothing-here");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      'no step, workflow, schedule, or monitor named "nothing-here"'
    );
  });
});
