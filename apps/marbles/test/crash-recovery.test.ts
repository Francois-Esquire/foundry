/**
 * Crash recovery across real processes in a test home of its own. The
 * first process hosts one step, `hold`, which starts a long host command
 * and records a harness activity, and is killed with SIGKILL while both
 * run. The next start over the same state stops the command it left, by
 * its recovery record, closes out its Run and its activity, and records
 * its Execution Run interrupted; a start after that changes nothing.
 *
 * Every process signalled here is one this test started: the host
 * process, tracked in the home's records when it is spawned, and the
 * command it started, which the home records too, so the home's teardown
 * stops whatever recovery did not.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { readStoredRuns } from "~/database/runs";
import {
  SPAWN_RECOVERY_ENV,
  type SpawnRecord,
  startedAt,
} from "~/process/spawned";
import { type TestHome, testHome } from "./helpers/home";

const SRC = resolve("src");
const HELPERS = resolve("test/helpers");
const PROCESS_TIMEOUT = 60_000;
const TEST_TIMEOUT = 180_000;
const POLL_MS = 50;
/** A Run its process still owes an outcome. */
const UNSETTLED = /^(queued|running)$/;

/** A host process over `<home>/state`, with `hold` and then `body`. */
function phase(home: TestHome, name: string, body: string): string {
  const script = join(home.path, `${name}.ts`);
  const state = join(home.path, "state");
  writeFileSync(
    script,
    `import { step } from ${JSON.stringify(join(SRC, "authoring/index.ts"))};
import { testEngine } from ${JSON.stringify(join(HELPERS, "engine.ts"))};
step("hold").do(async ({ exec }) => {
  await exec(["sleep", "300"]);
  return "done";
});
const lines = [];
const engine = testEngine({
  print: (line) => lines.push(line),
  spawned: process.env.${SPAWN_RECOVERY_ENV},
  state: ${JSON.stringify(state)},
});
await engine.start();
const report = { pid: process.pid };
const until = async (check) => {
  for (let i = 0; i < 1500; i += 1) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("timed out");
};
${body}
report.lines = lines;
await engine.dispose();
process.stdout.write(JSON.stringify(report) + "\\n");
process.exit(0);
`
  );
  return script;
}

function phaseEnv(home: TestHome): Record<string, string> {
  return { ...home.env, [SPAWN_RECOVERY_ENV]: home.layout.spawned };
}

function run(home: TestHome, script: string): Record<string, unknown> {
  const output = execFileSync("bun", [script], {
    cwd: resolve("."),
    encoding: "utf8",
    env: phaseEnv(home),
    timeout: PROCESS_TIMEOUT,
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

/** The recovery records the host's children left, other than `except`'s. */
function recoveryRecords(home: TestHome, except: number): SpawnRecord[] {
  const dir = home.layout.spawned;
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as SpawnRecord
    )
    .filter((record) => record.pid !== except);
}

async function waitFor<T>(find: () => T | undefined): Promise<T> {
  const deadline = Date.now() + PROCESS_TIMEOUT;
  for (;;) {
    const found = find();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

function exited(child: ChildProcess): Promise<unknown> {
  return child.exitCode === null && child.signalCode === null
    ? new Promise((done) => child.once("exit", done))
    : Promise.resolve();
}

function runs(home: TestHome) {
  return readStoredRuns(join(home.path, "state"), "test");
}

it(
  "a start after a host is killed mid-run stops what it left running and closes out its run, once",
  async () => {
    const home = testHome();
    const crash = phase(
      home,
      "crash",
      `const launched = await engine.launch("hold", {});
launched.result.catch(() => undefined);
await until(async () => engine.executions.get(launched.id)?.status === "running");
await engine.activities.record(
  {
    actions: ["stop"],
    agentId: "agent",
    harness: "claude-code",
    id: "activity",
    kind: "task",
    lifetime: "session",
    revision: 1,
    sessionId: "session",
    status: "running",
    title: "Watching",
  },
  { definition: "hold", path: ["hold"], runId: launched.id }
);
process.stdout.write(JSON.stringify({ runId: launched.id }) + "\\n");
await new Promise(() => undefined);`
    );
    const host = spawn("bun", [crash], {
      cwd: resolve("."),
      env: phaseEnv(home),
      stdio: ["ignore", "pipe", "inherit"],
    });
    home.track(host.pid, false);
    let output = "";
    host.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const { runId } = await waitFor(() =>
      output.includes("\n")
        ? (JSON.parse(output.split("\n")[0] ?? "{}") as { runId: string })
        : undefined
    );
    // The command the step started, recorded with the host as its owner.
    const command = await waitFor(() =>
      recoveryRecords(home, host.pid ?? 0).at(0)
    );
    expect(command.owner?.pid).toBe(host.pid);
    host.kill("SIGKILL");
    await exited(host);
    // Left running by the host it outlived, its Run unsettled.
    expect(startedAt(command.pid)).toBe(command.started);
    expect(
      (await runs(home)).find((entry) => entry.id === runId)?.status
    ).toMatch(UNSETTLED);

    const inspect = (name: string) =>
      phase(
        home,
        name,
        `const id = ${JSON.stringify(runId)};
report.execution = engine.executions.get(id);
report.activities = engine.activities.list().map((record) => record.event);`
      );
    const recovered = run(home, inspect("recover"));
    expect(startedAt(command.pid)).not.toBe(command.started);
    expect(recoveryRecords(home, recovered.pid as number)).toEqual([]);
    expect(recovered.execution).toMatchObject({
      error: { code: "interrupted" },
      status: "interrupted",
    });
    expect(
      (await runs(home)).find((entry) => entry.id === runId)
    ).toMatchObject({ owner: null, status: "failed" });
    expect(recovered.activities).toEqual([
      expect.objectContaining({
        actions: [],
        revision: 2,
        status: "failed",
        summary: "its process exited while it was running",
      }),
    ]);
    expect(recovered.lines).toEqual(
      expect.arrayContaining([
        "[recovery] stopped 1 process(es) a gone engine left running",
        `[run] hold ${runId} closed out: its process exited while it was running`,
        "[recovery] closed out 1 harness activity(ies)",
      ])
    );

    // Again: nothing is left to put right, and nothing changes.
    const again = run(home, inspect("again"));
    expect(
      (again.lines as string[]).filter(
        (line) => line.startsWith("[recovery]") || line.includes("closed out")
      )
    ).toEqual([]);
    expect(again.execution).toEqual(recovered.execution);
    expect(again.activities).toEqual(recovered.activities);
    expect((await runs(home)).find((entry) => entry.id === runId)?.status).toBe(
      "failed"
    );
  },
  TEST_TIMEOUT
);
