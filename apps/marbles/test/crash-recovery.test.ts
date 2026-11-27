import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { anotherStart } from "@foundry/lib/testing/process-identity";
import type { RunId } from "@foundry/queue";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import { expect, it } from "vitest";
import { readLastRecovery, writeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import { runStoreEffect } from "~/lib/workflow-runs";
import { type SpawnRecord, startedAt } from "~/process/spawned";
import { testEngine } from "./helpers/engine";
import { type TestHome, testHome } from "./helpers/home";
import { readStoredRuns } from "./helpers/stored-runs";

const SRC = resolve("src");
const HELPERS = resolve("test/helpers");
const PROCESS_TIMEOUT = 60_000;
const TEST_TIMEOUT = 180_000;
const POLL_MS = 50;
const LONG_AGO = anotherStart();
const UNSETTLED = /^(queued|running)$/;

function phase(home: TestHome, name: string, body: string): string {
  const script = join(home.path, `${name}.ts`);
  const state = join(home.path, "state");
  writeFileSync(
    script,
    `import { Catalog, step } from ${JSON.stringify(join(SRC, "authoring/index.ts"))};
import { testEngine } from ${JSON.stringify(join(HELPERS, "engine.ts"))};
const hold = step("hold").do(async ({ exec }) => {
  await exec(["sleep", "300"]);
  return "done";
});
const lines = [];
const killOn = process.env.MARBLES_TEST_KILL_ON;
const engine = testEngine({
  catalog: Catalog.collect([hold]),
  print: (line) => {
    lines.push(line);
    // Dies right after this point of recovery, as a crash would.
    if (killOn && line.startsWith(killOn)) process.kill(process.pid, "SIGKILL");
  },
  spawned: ${JSON.stringify(home.layout.spawned)},
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

function run(home: TestHome, script: string): Record<string, unknown> {
  const output = execFileSync("bun", [script], {
    cwd: resolve("."),
    encoding: "utf8",
    env: home.env,
    timeout: PROCESS_TIMEOUT,
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

function runKilled(home: TestHome, script: string, killOn: string): unknown {
  try {
    execFileSync("bun", [script], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...home.env, MARBLES_TEST_KILL_ON: killOn },
      stdio: "pipe",
      timeout: PROCESS_TIMEOUT,
    });
  } catch (error) {
    return (error as { signal?: string }).signal;
  }
  return "exited";
}

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
    env: home.env,
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
  const command = await waitFor(() =>
    recoveryRecords(home, host.pid ?? 0).at(0)
  );
  expect(command.owner?.pid).toBe(host.pid);
  host.kill("SIGKILL");
  await exited(host);
  expect(startedAt(command.pid)).toBe(command.started);
  expect(
    (await runs(home)).find((entry) => entry.id === runId)?.status
  ).toMatch(UNSETTLED);

  return { command, runId };
}

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
    error: { message: "owner gone", name: "interrupted" },
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
        `[run] hold ${runId} closed out: owner gone`,
        "[recovery] runs: done, 1 run(s) closed out",
        "[recovery] activities: done, 1 harness activity(ies) closed out",
      ])
    );

    const again = run(home, inspection(home, "again", runId));
    expect(
      (again.lines as string[]).filter(
        (line) => line.startsWith("[recovery]") || line.includes("closed out")
      )
    ).toEqual([]);
    expect(again.execution).toEqual(recovered.execution);
    expect(again.run).toEqual(recovered.run);
    expect(again.activities).toEqual(recovered.activities);
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
    await writeDatabase(stateDatabase(state), async (database) => {
      const store = makeSqliteQueueStore({ database, scope: "test" });
      const left = await runStoreEffect(store.getRun(runId as RunId));
      if (left?.state.kind !== "running") {
        throw new Error(`${runId} is not running`);
      }
      const owner = { pid: process.pid, started: LONG_AGO };
      await runStoreEffect(
        store.commit({
          runs: [
            {
              ...left,
              revision: left.revision + 1,
              state: { ...left.state, lease: { ...left.state.lease, owner } },
            },
          ],
        })
      );
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
      expect(engine.executions.get(runId)?.owner).toBeUndefined();
    } finally {
      await engine.dispose();
    }
  },
  TEST_TIMEOUT
);
