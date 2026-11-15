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
import { thisProcess } from "@foundry/lib/process-identity";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { writeDatabase } from "~/database/open";
import { readLastRecovery } from "~/database/recoveries";
import { readStoredRuns } from "~/database/runs";
import { marblesExecutions, marblesWorkflowRuns } from "~/database/tables";
import { stateDatabase } from "~/layout";
import {
  SPAWN_RECOVERY_ENV,
  type SpawnRecord,
  startedAt,
} from "~/process/spawned";
import { testEngine } from "./helpers/engine";
import { type TestHome, testHome } from "./helpers/home";

const SRC = resolve("src");
const HELPERS = resolve("test/helpers");
const PROCESS_TIMEOUT = 60_000;
const TEST_TIMEOUT = 180_000;
const POLL_MS = 50;
const LONG_AGO = "Thu Jan  1 00:00:00 1970";
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
const killOn = process.env.MARBLES_TEST_KILL_ON;
const engine = testEngine({
  print: (line) => {
    lines.push(line);
    // Dies right after this point of recovery, as a crash would.
    if (killOn && line.startsWith(killOn)) process.kill(process.pid, "SIGKILL");
  },
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

/** Run `script` until it kills itself at the first line starting `killOn`. */
function runKilled(home: TestHome, script: string, killOn: string): unknown {
  try {
    execFileSync("bun", [script], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...phaseEnv(home), MARBLES_TEST_KILL_ON: killOn },
      stdio: "pipe",
      timeout: PROCESS_TIMEOUT,
    });
  } catch (error) {
    return (error as { signal?: string }).signal;
  }
  return "exited";
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

/**
 * A host over `home` that launched `hold`, whose step started `sleep`,
 * recorded a harness activity, and was killed with SIGKILL: the run, and
 * the command it left running.
 */
async function crashedHost(
  home: TestHome
): Promise<{ readonly command: SpawnRecord; readonly runId: string }> {
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

  return { command, runId };
}

/** A phase that reports how the engine sees the run after its start. */
function inspection(home: TestHome, name: string, runId: string): string {
  return phase(
    home,
    name,
    `const id = ${JSON.stringify(runId)};
report.execution = engine.executions.get(id);
report.run = (await engine.runs()).find((run) => run.id === id);
report.activities = engine.activities.list().map((record) => record.event);
report.recovery = engine.lastRecovery;`
  );
}

/** What every start after the crash leaves, however many it took. */
async function expectRecovered(
  home: TestHome,
  report: Record<string, unknown>,
  command: SpawnRecord,
  runId: string
): Promise<void> {
  expect(startedAt(command.pid)).not.toBe(command.started);
  expect(recoveryRecords(home, report.pid as number)).toEqual([]);
  expect(report.execution).toMatchObject({
    error: { code: "interrupted" },
    status: "interrupted",
  });
  expect(report.run).toMatchObject({
    error: {
      message: "its process exited while it was running",
      name: "Interrupted",
    },
    status: "failed",
  });
  expect((await runs(home)).find((entry) => entry.id === runId)).toMatchObject({
    owner: null,
    status: "failed",
  });
  expect(report.activities).toEqual([
    expect.objectContaining({
      actions: [],
      revision: 2,
      status: "failed",
      summary: "its process exited while it was running",
    }),
  ]);
}

it(
  "a start after a host is killed mid-run stops what it left running and closes out its run, once",
  async () => {
    const home = testHome();
    const { command, runId } = await crashedHost(home);

    const recovered = run(home, inspection(home, "recover", runId));
    await expectRecovered(home, recovered, command, runId);
    expect(recovered.lines).toEqual(
      expect.arrayContaining([
        "[recovery] processes: done, 1 process(es) stopped",
        `[run] hold ${runId} closed out: its process exited while it was running`,
        "[recovery] runs: done, 1 run(s) closed out",
        "[recovery] activities: done, 1 harness activity(ies) closed out",
      ])
    );

    // Again: nothing is left to put right, and nothing changes.
    const again = run(home, inspection(home, "again", runId));
    expect(
      (again.lines as string[]).filter(
        (line) => line.startsWith("[recovery]") || line.includes("closed out")
      )
    ).toEqual([]);
    expect(again.execution).toEqual(recovered.execution);
    expect(again.run).toEqual(recovered.run);
    expect(again.activities).toEqual(recovered.activities);
    // What each start did is kept for `marbles status`: the last one's.
    expect(recovered.recovery).toMatchObject({
      steps: [
        { detail: "1 process(es) stopped", outcome: "done", step: "processes" },
        { outcome: "skipped", step: "containers" },
        { detail: "1 run(s) closed out", outcome: "done", step: "runs" },
        {
          detail: "1 harness activity(ies) closed out",
          outcome: "done",
          step: "activities",
        },
        { outcome: "done", step: "artifacts" },
      ],
    });
    expect(await readLastRecovery(join(home.path, "state"), "test")).toEqual(
      again.recovery
    );
  },
  TEST_TIMEOUT
);

it.each([
  ["once its orphans are stopped, the Run still open", "[recovery] processes:"],
  ["once its Run is closed out, the activity still open", "[run] hold"],
])(
  "a start killed during recovery, %s, is finished by the next",
  async (_point, killOn) => {
    const home = testHome();
    const { command, runId } = await crashedHost(home);

    expect(runKilled(home, inspection(home, "cut", runId), killOn)).toBe(
      "SIGKILL"
    );
    const finished = run(home, inspection(home, "finish", runId));
    await expectRecovered(home, finished, command, runId);
  },
  TEST_TIMEOUT
);

it(
  "a start after a reboot takes a run whose owner had this process's pid, started earlier, for a gone engine's, and settles it",
  async () => {
    const home = testHome();
    const { command, runId } = await crashedHost(home);
    const state = join(home.path, "state");
    // As after a reboot: the run's owner had the pid this process has now.
    const before = { ownerPid: process.pid, ownerStarted: LONG_AGO };
    await writeDatabase(stateDatabase(state), async (database) => {
      await database
        .update(marblesExecutions)
        .set(before)
        .where(eq(marblesExecutions.id, runId));
      await database
        .update(marblesWorkflowRuns)
        .set(before)
        .where(eq(marblesWorkflowRuns.runId, runId));
    });

    const engine = testEngine({
      print: () => undefined,
      spawned: home.layout.spawned,
      state,
    });
    await engine.start();
    try {
      await expectRecovered(
        home,
        {
          activities: engine.activities.list().map((record) => record.event),
          execution: engine.executions.get(runId),
          pid: process.pid,
          run: (await engine.runs()).find((entry) => entry.id === runId),
        },
        command,
        runId
      );
      expect(engine.executions.get(runId)?.owner).toEqual(thisProcess());
    } finally {
      await engine.dispose();
    }
  },
  TEST_TIMEOUT
);
