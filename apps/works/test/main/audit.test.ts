import { spawnSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryArtifactStore } from "@foundry/artifacts";
import { JsonArtifactStore } from "@foundry/artifacts/node";
import type { ModuleVersion } from "@foundry/modules/domain";
import type { ExecutionRun, TaskContext } from "@foundry.sh/marbles/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductFiles } from "~/main/artifacts/files";
import { auditRun, ExecutionAudit } from "~/main/execution/audit";
import { moduleQueue } from "~/main/execution/contract";
import { startWorksEngine } from "~/main/execution/engine";
import { routeModuleLibrary } from "~/main/execution/library";
import {
  DEFAULT_RETENTION,
  ExecutionRetention,
  HOST_AUDIT_SCOPE,
} from "~/main/execution/retention";
import { modulePersistence } from "~/main/modules/artifact-store";
import { createModuleLibrary } from "~/main/modules/library";
import { ModuleSessions } from "~/main/modules/runtime/controller";
import { moduleInstallationId } from "~/main/modules/runtime/installation";
import {
  GATEWAY_CALLS_PER_PROGRAM,
  ProgramCalls,
} from "~/main/modules/runtime/program-calls";
import { ModuleSettings } from "~/main/modules/settings";
import {
  type AuditEvent,
  type AuditState,
  applyAuditEvent,
  artifactSaves,
  auditDashboard,
  callRows,
  failedSaveAttempt,
  scopedRuns,
} from "~/shared/audit";
import { WORKS_TASKS } from "~/shared/execution";
import {
  runAuditScenario,
  SCENARIO_FILE_BODY,
  SCENARIO_PROMPT,
  SCENARIO_SOURCE_BODY,
} from "../helpers/audit-scenario";
import { startTestExecution } from "../helpers/execution";
import { installedProcess } from "../helpers/installed-programs";
import { buildResult, TEST_BUILD_RUN } from "../helpers/module-build";
import { recordedSaves, unrecordedSaves } from "../helpers/source-saves";
import { weatherProvider } from "../helpers/weather-provider";
import { COMPOSED_WORKS_TIMEOUT_MS } from "../helpers/works";

const cleanups: (() => Promise<void>)[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function temporary(prefix = "works-audit-") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  cleanups.push(() =>
    rm(directory, { force: true, maxRetries: 5, recursive: true })
  );
  return directory;
}

function named(runs: readonly ExecutionRun[], name: string) {
  return runs.filter((run) => run.name === name);
}

/** Every file under `directory`, with its text. */
async function filesUnder(directory: string): Promise<[string, string][]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry): Promise<[string, string]> => {
        const file = path.join(entry.parentPath, entry.name);
        return [file, await readFile(file, "utf8")];
      })
  );
}

/** Collect a watch's events until `count` have arrived. */
async function take(
  events: AsyncIterator<AuditEvent>,
  count: number
): Promise<AuditEvent[]> {
  const seen: AuditEvent[] = [];
  while (seen.length < count) {
    const next = await events.next();
    if (next.done) {
      break;
    }
    seen.push(next.value);
  }
  return seen;
}

function reduce(
  events: readonly AuditEvent[],
  state: AuditState | null = null
) {
  return events.reduce<AuditState | null>(applyAuditEvent, state);
}

/** A pid that belonged to a process which has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid ?? 999_999;
}

describe("engine run-store coverage", {
  timeout: COMPOSED_WORKS_TIMEOUT_MS,
}, () => {
  it("records every Works action as an engine run with typed observations", async () => {
    const directory = await temporary();
    const scenario = await runAuditScenario(directory);
    const { execution, moduleId } = scenario;
    cleanups.push(() => scenario.close());
    const runs = execution.runs.list();

    expect(named(runs, WORKS_TASKS.create)).toHaveLength(2);
    expect(named(runs, WORKS_TASKS.save).map((run) => run.status)).toEqual([
      "complete",
      "failed",
    ]);
    const [build] = named(runs, WORKS_TASKS.build);
    const [publish] = named(runs, WORKS_TASKS.publish);
    expect(build).toMatchObject({
      correlation: { moduleId },
      status: "complete",
    });
    // The release is attributed to its build.
    expect(publish?.correlation).toEqual({
      moduleId,
      parentRunId: build?.id,
    });
    expect(named(runs, WORKS_TASKS.settings)[0]?.observations).toMatchObject([
      { kind: "result", type: "settings" },
    ]);
    expect(named(runs, WORKS_TASKS.fileCreate)[0]?.observations).toMatchObject([
      { data: { actor: "user", kind: "file" }, type: "create" },
    ]);
    expect(
      named(runs, WORKS_TASKS.fileSave).map((run) =>
        run.observations.map((observation) =>
          observation.kind === "result" ? observation.type : observation.kind
        )
      )
    ).toEqual([["save"], ["attempt"]]);
    expect(named(runs, WORKS_TASKS.program)[0]).toMatchObject({
      status: "complete",
    });
    expect(execution.runs.get(scenario.workflowRunId)).toMatchObject({
      correlation: { moduleId, workflow: "works.examples.ticker@1" },
      queue: moduleQueue(moduleId, "workflows"),
      status: "complete",
    });
    expect(execution.runs.get(scenario.turnRunId)).toMatchObject({
      correlation: { moduleId: scenario.chatModuleId },
      name: WORKS_TASKS.authoringTurn,
      status: "complete",
    });
  });

  it("projects saves, failed attempts and calls from the retained runs", async () => {
    const directory = await temporary();
    const scenario = await runAuditScenario(directory);
    const { execution, moduleId } = scenario;
    cleanups.push(() => scenario.close());
    const runs = execution.runs.list().map(auditRun);

    const saves = artifactSaves(runs);
    expect(
      saves.map((save) => [save.kind, save.action, save.origin, save.tag])
    ).toEqual(
      expect.arrayContaining([
        ["source", "saved", "user", undefined],
        ["release", "saved", "build", "0.1.0"],
        ["file", "created", "user", undefined],
        ["file", "saved", "user", undefined],
      ])
    );
    // Failures never appear as saves; they are typed attempts.
    const attempts = runs
      .map((run) => [run.name, failedSaveAttempt(run)] as const)
      .filter(([, attempt]) => attempt !== null);
    expect(attempts).toEqual([
      [WORKS_TASKS.save, expect.any(String)],
      [WORKS_TASKS.fileSave, "conflict"],
    ]);
    const attemptRuns = new Set(
      runs.filter((run) => failedSaveAttempt(run) !== null).map((run) => run.id)
    );
    expect(saves.some((save) => attemptRuns.has(save.runId))).toBe(false);

    // Calls: a real coding turn's model turns and tool calls, and Gateway calls.
    const calls = callRows(runs);
    const turn = calls.filter((call) => call.runId === scenario.turnRunId);
    expect(turn.filter((call) => call.kind === "model-turn")).not.toHaveLength(
      0
    );
    expect(turn).toContainEqual(
      expect.objectContaining({
        kind: "tool-call",
        moduleId: scenario.chatModuleId,
        name: "write",
        status: "complete",
      })
    );
    expect(
      calls
        .filter((call) => call.kind === "gateway")
        .map((call) => [call.name, call.status, call.moduleId])
        .sort()
    ).toEqual([
      ["works.artifacts.save@1", "denied", moduleId],
      ["works.system.theme@1", "complete", moduleId],
    ]);
    const dashboard = auditDashboard(runs);
    expect(dashboard.cost).toBe("unknown");
    expect(dashboard.coverage.turns).toBeGreaterThan(0);
    expect(dashboard.coverage.measured).toBe(dashboard.coverage.turns);
    expect(dashboard.calls.gateway).toBe(2);
  });

  it("keeps secrets, prompts and file bodies out of the run store and audit payloads", async () => {
    const directory = await temporary();
    const scenario = await runAuditScenario(directory);
    cleanups.push(() => scenario.close());
    const planted = [SCENARIO_PROMPT, SCENARIO_FILE_BODY, SCENARIO_SOURCE_BODY];
    const files = await filesUnder(path.join(directory, "engine", "state"));
    expect(files.length).toBeGreaterThan(10);
    for (const [file, text] of files) {
      for (const secret of planted) {
        expect(text, file).not.toContain(secret.trim());
      }
    }
    const audit = new ExecutionAudit({ runs: scenario.execution.runs });
    const controller = new AbortController();
    const [snapshot] = await take(audit.watch(controller.signal), 1);
    controller.abort();
    const payload = JSON.stringify(snapshot);
    for (const secret of planted) {
      expect(payload).not.toContain(secret.trim());
    }
    expect(payload).not.toContain('"input":{"request"');
    // The conversation itself is the Agent Session's separate persistence.
    const sessions = await filesUnder(
      path.join(directory, "engine", "sessions")
    );
    expect(sessions.some(([, text]) => text.includes(SCENARIO_PROMPT))).toBe(
      true
    );
  });

  it("keeps a failed chat turn's provider text out of the run, with its code", async () => {
    const execution = await startTestExecution();
    const failure = Object.assign(
      new Error("401 Incorrect API key provided: sk-planted-123"),
      { name: "AI_APICallError", statusCode: 401 }
    );
    const launched = await execution.launch(
      WORKS_TASKS.authoringTurn,
      { recordErrorMessage: false },
      () => Promise.reject(failure)
    );
    // The caller still gets the error itself.
    await expect(launched.result).rejects.toBe(failure);
    const run = execution.runs.get(launched.id);
    expect(run?.error).toEqual({ code: "AI_APICallError:401" });
    expect(JSON.stringify(run)).not.toContain("sk-planted");
  });
});

describe("Gateway invocations on Program runs", () => {
  const weather = {
    capabilities: [
      {
        alias: "weather",
        capability: "host.weather.read",
        constraints: { city: "Oslo" },
        reason: "Shows the forecast",
        required: false,
        version: 1,
      },
    ],
  };

  it("records each invocation of an open app, granted or denied, without its input", async () => {
    const directory = await temporary();
    const execution = await startTestExecution();
    const calls = new ProgramCalls();
    const works = installedProcess(
      new JsonArtifactStore({ path: path.join(directory, "artifacts.json") }),
      execution,
      directory,
      [weatherProvider()],
      { calls }
    );
    const module = await works.library.create("Weather");
    const version = await works.release(module.id, "0.1.0", weather);
    await works.access.approve(module.id, "host.weather.read");
    const app = works.sessions.watch(module.id, version.contentId);
    await app.next();
    const runtime = await works.programs.active(
      moduleInstallationId(module.id)
    );
    if (!runtime) {
      throw new Error("Program not active");
    }
    const invoke = (id: string) =>
      works.invocations.dispatch({
        capabilities: version.manifest.capabilities,
        request: {
          alias: "weather",
          id,
          input: { city: "planted-city-input" },
          kind: "invoke",
          mode: "unary",
        },
        runtime,
        signal: new AbortController().signal,
      });
    await invoke("1");
    await works.access.revoke(module.id, "host.weather.read");
    await expect(invoke("2")).rejects.toMatchObject({ code: "unauthorized" });
    await app.return();

    const [program] = named(execution.runs.list(), WORKS_TASKS.program);
    expect(program?.status).toBe("complete");
    expect(
      program?.observations.map((observation) =>
        observation.kind === "effect"
          ? [observation.type, observation.status, observation.errorCode]
          : null
      )
    ).toEqual([
      ["gateway", "complete", undefined],
      ["gateway", "denied", "unauthorized"],
    ]);
    expect(program?.observations[0]).toMatchObject({
      data: {
        capability: "host.weather.read",
        mode: "unary",
        runtimeInstanceId: runtime.runtimeInstanceId,
        version: 1,
      },
      id: `runtime:${runtime.runtimeInstanceId}:request:1`,
    });
    expect(JSON.stringify(program)).not.toContain("planted-city-input");
  });

  it("counts invocations past the per-Program limit instead of listing them", () => {
    const observed: unknown[] = [];
    const context = {
      observe: (observation: unknown) => {
        observed.push(observation);
        return true;
      },
    } as unknown as TaskContext;
    const calls = new ProgramCalls();
    const detach = calls.attach("module-a", context);
    const principal = { moduleId: "module-a", runtimeInstanceId: "r" } as never;
    for (let index = 0; index < GATEWAY_CALLS_PER_PROGRAM + 3; index += 1) {
      calls.record({
        endedAt: new Date().toISOString(),
        invocationId: `call-${String(index)}`,
        mode: "unary",
        principal,
        startedAt: new Date().toISOString(),
        status: "complete",
      });
    }
    // Another Module's calls never land on this run.
    calls.record({
      endedAt: new Date().toISOString(),
      invocationId: "other",
      mode: "unary",
      principal: { moduleId: "module-b" } as never,
      startedAt: new Date().toISOString(),
      status: "complete",
    });
    detach();
    expect(observed).toHaveLength(GATEWAY_CALLS_PER_PROGRAM + 1);
    expect(observed.at(-1)).toMatchObject({
      data: { count: 3 },
      type: "gateway-unrecorded",
    });
  });
});

describe("run-store retention", () => {
  async function savesFixture() {
    const directory = await temporary();
    const execution = await startTestExecution({
      directory: path.join(directory, "engine"),
    });
    const store = new JsonArtifactStore({
      path: path.join(directory, "artifacts.json"),
    });
    const library = routeModuleLibrary(
      createModuleLibrary(store, { saves: recordedSaves(execution, store) }),
      execution
    );
    const module = await library.create("Retained");
    let binding = (await library.details(module.id))?.binding;
    for (const text of ["one", "two", "three"]) {
      const details = await library.details(module.id);
      if (!(details && binding)) {
        throw new Error("Binding missing");
      }
      binding = await library.saveSource(
        module.id,
        { ...details.source, "README.md": text },
        binding
      );
    }
    const files = new ProductFiles({
      artifacts: modulePersistence(store).artifacts,
      execution,
      root: path.join(directory, "artifacts"),
    });
    cleanups.push(() => files.close());
    await files.ready();
    const created = await files.create({
      actor: { kind: "user" },
      bytes: new TextEncoder().encode("a"),
      mime: "text/markdown",
      name: "Notes",
      path: "notes.md",
    });
    if (created.kind !== "created") {
      throw new Error("not created");
    }
    let { digest } = created;
    for (const text of ["b", "c"]) {
      const saved = await files.save({
        actor: { kind: "user" },
        artifactId: created.artifactId,
        expectedDigest: digest,
        path: "notes.md",
        text,
      });
      if (saved.kind !== "saved") {
        throw new Error("not saved");
      }
      ({ digest } = saved);
    }
    return { created, directory, execution, files, library, module, store };
  }

  it("prunes only settled runs past retention, keeping each Artifact's latest save and active work", async () => {
    const { created, directory, execution, module, store } =
      await savesFixture();
    // A Program still running when retention runs.
    const release = Promise.withResolvers<void>();
    const program = await execution.launch(
      WORKS_TASKS.program,
      { correlation: { moduleId: module.id } },
      async (context) => {
        context.release();
        await release.promise;
      }
    );
    cleanups.push(async () => {
      release.resolve();
      await program.result;
    });
    const before = execution.runs.list();
    const latest = (name: string) => named(before, name).at(-1)?.id;
    const keep = [
      latest(WORKS_TASKS.save),
      latest(WORKS_TASKS.fileSave),
      program.id,
    ];

    const retention = new ExecutionRetention({
      now: () => new Date(Date.now() + 31 * DAY_MS),
      runs: execution.runs,
    });
    const compaction = await retention.compact();
    expect(
      execution.runs
        .list()
        .map((run) => run.id)
        .sort()
    ).toEqual(keep.sort());
    expect(compaction.removed).toHaveLength(before.length - keep.length);
    expect(
      Object.fromEntries(
        execution.runs.gaps().map((gap) => [gap.scope, gap.removed])
      )
    ).toEqual({
      // Create, three saves and the file create/saves are host or Module runs.
      [HOST_AUDIT_SCOPE]: named(before, WORKS_TASKS.create).length + 2,
      [`module:${module.id}`]: 2,
    });

    // The kept checkpoints are what startup recovery reads: nothing to recover.
    const again = new ProductFiles({
      artifacts: modulePersistence(store).artifacts,
      execution,
      root: path.join(directory, "artifacts"),
    });
    cleanups.push(() => again.close());
    await again.ready();
    expect(named(execution.runs.list(), WORKS_TASKS.fileRecover)).toEqual([]);
    expect(
      (
        await again.read(created.artifactId, "notes.md", {
          length: 9,
          offset: 0,
        })
      )?.bytes
    ).toBe(1);
  });

  it("keeps a Module's newest settled runs up to its entry limit, from its settings", async () => {
    const { execution, library, module } = await savesFixture();
    const settings = new ModuleSettings({
      directory: await temporary(),
      execution,
      library,
    });
    await settings.set(module.id, { "audit.maxTerminalEntries": 2 });
    expect(await settings.auditRetention(module.id)).toEqual({
      maxTerminalEntries: 2,
      retentionDays: DEFAULT_RETENTION.retentionDays,
    });
    const moduleRuns = () =>
      execution.runs
        .list()
        .filter((run) => run.correlation.moduleId === module.id);
    expect(moduleRuns()).toHaveLength(4);
    const retention = new ExecutionRetention({
      policy: (moduleId) => settings.auditRetention(moduleId),
      runs: execution.runs,
    });
    await retention.compact();
    // The newest two: the last source save and the settings change.
    expect(moduleRuns().map((run) => run.name)).toEqual([
      WORKS_TASKS.save,
      WORKS_TASKS.settings,
    ]);
    // Nothing of the host scope was old enough or over its limit.
    expect(execution.runs.gaps().map((gap) => gap.scope)).toEqual([
      `module:${module.id}`,
    ]);
  });

  it("keeps gaps and pruned history across a restart of the engine", async () => {
    const directory = await temporary();
    const engine = path.join(directory, "engine");
    const first = await startWorksEngine({ directory: engine });
    const library = routeModuleLibrary(
      createModuleLibrary(new InMemoryArtifactStore(), {
        saves: unrecordedSaves,
      }),
      first
    );
    await library.create("One");
    await library.create("Two");
    await new ExecutionRetention({
      now: () => new Date(Date.now() + 31 * DAY_MS),
      runs: first.runs,
    }).compact();
    const gaps = first.runs.gaps();
    expect(gaps).toMatchObject([{ removed: 2, scope: HOST_AUDIT_SCOPE }]);
    await first.close();
    const second = await startWorksEngine({ directory: engine });
    cleanups.push(() => second.close());
    expect(second.runs.gaps()).toEqual(gaps);
    expect(second.runs.list()).toEqual([]);
  });
});

describe("crash durability", () => {
  it("shows unfinished work after a crash: running interrupted, queued settled without effect, saves kept", async () => {
    const directory = await temporary();
    const engine = path.join(directory, "engine");
    const first = await startWorksEngine({ directory: engine });
    cleanups.push(() => first.close());
    const store = new InMemoryArtifactStore();
    const library = routeModuleLibrary(
      createModuleLibrary(store, { saves: recordedSaves(first, store) }),
      first
    );
    const module = await library.create("Crashing");
    const details = await library.details(module.id);
    if (!details?.binding) {
      throw new Error("Binding missing");
    }
    await library.saveSource(
      module.id,
      { ...details.source, "README.md": "kept" },
      details.binding
    );
    const sessions = new ModuleSessions({
      execution: first,
      library,
      runtime: {
        revoked: () => undefined,
        shutdown: () => Promise.resolve(),
        start: (_version: ModuleVersion) =>
          Promise.resolve({
            close: () => Promise.resolve(),
            origin: "http://127.0.0.1:3000",
          }),
      },
    });
    const latest = await library.details(module.id);
    if (!latest?.binding) {
      throw new Error("Binding missing");
    }
    const release = await library.publish(module.id, latest.binding, {
      ...buildResult(latest.source),
      builtBy: TEST_BUILD_RUN,
      tag: "0.1.0",
    });
    const app = sessions.watch(module.id, release.version.contentId);
    await app.next();
    // One chat turn holds the Module's authoring slot; the next waits.
    const hold = Promise.withResolvers<void>();
    const queue = { kind: "authoring", moduleId: module.id } as const;
    const running = await first.launch(
      WORKS_TASKS.authoringTurn,
      { correlation: { moduleId: module.id }, queue },
      () => hold.promise
    );
    const waiting = await first.launch(
      WORKS_TASKS.authoringTurn,
      { correlation: { moduleId: module.id }, queue },
      () => undefined
    );
    expect(first.runs.get(waiting.id)?.status).toBe("queued");
    cleanups.push(async () => {
      hold.resolve();
      await app.return();
      await Promise.allSettled([running.result, waiting.result]);
    });

    // The crash: the store as the dead process left it.
    const copy = path.join(directory, "after-crash");
    await cp(engine, copy, { recursive: true });
    const dead = deadPid();
    const executions = path.join(copy, "state", "executions");
    for (const file of await readdir(executions)) {
      const record = JSON.parse(
        await readFile(path.join(executions, file), "utf8")
      ) as ExecutionRun;
      await writeFile(
        path.join(executions, file),
        JSON.stringify({ ...record, owner: { pid: dead } })
      );
    }

    const second = await startWorksEngine({ directory: copy });
    cleanups.push(() => second.close());
    const [program] = named(second.runs.list(), WORKS_TASKS.program);
    expect(program).toMatchObject({
      error: { code: "interrupted" },
      status: "interrupted",
    });
    expect(second.runs.get(running.id)).toMatchObject({
      status: "interrupted",
    });
    await vi.waitFor(() =>
      expect(second.runs.get(waiting.id)).toMatchObject({
        error: { code: "AbandonedRequest" },
        status: "failed",
      })
    );
    // The committed save survives with its result; nothing appears as saved twice.
    const saves = artifactSaves(second.runs.list().map(auditRun));
    expect(saves.map((save) => [save.kind, save.tag])).toEqual(
      expect.arrayContaining([
        ["source", undefined],
        ["release", "0.1.0"],
      ])
    );
    expect(saves).toHaveLength(2);
  });
});

describe("audit watch", () => {
  it("sends a snapshot then each change, reconciles without duplicates, and refreshes on reconnect", async () => {
    const execution = await startTestExecution();
    const library = routeModuleLibrary(
      createModuleLibrary(new InMemoryArtifactStore(), {
        saves: unrecordedSaves,
      }),
      execution
    );
    await library.create("Before");
    const retention = new ExecutionRetention({
      now: () => new Date(Date.now() + 31 * DAY_MS),
      runs: execution.runs,
    });
    const audit = new ExecutionAudit({ retention, runs: execution.runs });
    const controller = new AbortController();
    const events = audit.watch(controller.signal);
    const [snapshot] = await take(events, 1);
    expect(snapshot).toMatchObject({ gaps: [], type: "snapshot" });
    expect(snapshot?.type === "snapshot" && snapshot.runs).toHaveLength(1);

    const module = await library.create("After");
    // Queued, running, its result, complete: one event per revision.
    const updates = await take(events, 4);
    expect(updates.map((event) => event.type)).toEqual([
      "run",
      "run",
      "run",
      "run",
    ]);
    // Replaying an event (a duplicate delivery) changes nothing.
    const state = reduce([...(snapshot ? [snapshot] : []), ...updates]);
    const replayed = reduce(updates, state);
    expect(replayed).toBe(state);
    expect(scopedRuns(state as AuditState).map((run) => run.status)).toEqual([
      "complete",
      "complete",
    ]);

    // Retention removes both: the watch says so, with the gap.
    await retention.compact();
    const [removed] = await take(events, 1);
    expect(removed).toMatchObject({
      gaps: [{ removed: 2, scope: HOST_AUDIT_SCOPE }],
      type: "removed",
    });
    const pruned = reduce(removed ? [removed] : [], state) as AuditState;
    expect(pruned.runs.size).toBe(0);
    expect(pruned.gaps).toHaveLength(1);

    // A reconnect is a fresh snapshot that replaces what the reader held.
    controller.abort();
    expect(await events.next()).toEqual({ done: true, value: undefined });
    await library.details(module.id);
    const again = audit.watch();
    const [fresh] = await take(again, 1);
    expect(reduce(fresh ? [fresh] : [], state)).toMatchObject({
      gaps: [{ scope: HOST_AUDIT_SCOPE }],
    });
    expect(fresh?.type === "snapshot" && fresh.runs).toEqual([]);
    await again.return();
  });
});
