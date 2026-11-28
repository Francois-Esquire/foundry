import { AsyncLocalStorage } from "node:async_hooks";

import { expectHost, releaseEngine } from "~/authoring/runtime";
import type { MarblesDatabase } from "~/database/open";

import { openHostDatabase } from "~/database/open";
import { inputFromFields, SchemaError } from "~/lib/definitions/schema";
import type { Engine } from "~/lib/engine";
import type { FeedReader } from "~/lib/feed/read";
import { runStoreEffect } from "~/lib/runs/records";
import { rollSchedule } from "~/lib/schedule";
import type { UsageRecords } from "~/lib/usage";
import type {
  DispatchInfo,
  DispatchOptions,
  RollResult,
  RunInfo,
  RunPage,
  WorkspaceActions,
  WorkspaceConfig,
  WorkspaceConnection,
} from "~/model/connection";
import type { DashboardSnapshot, LiveRun } from "~/model/dashboard";
import type { Workspace } from "~/state/workspace";
import { BackgroundRuns } from "~/workspace/background-runs";
import { Diagnostics, hostOutput } from "~/workspace/diagnostics";
import { workspaceFeed } from "~/workspace/feed";
import { liveView, questionOwners } from "~/workspace/live-work";
import { runSchedulesUntilStopped } from "~/workspace/loop";
import type { OpenedWorkspace } from "~/workspace/open";
import {
  asRegistered,
  hostEngine,
  hostTasks,
  openWorkspace,
  touchWorkspace,
} from "~/workspace/open";
import { otherWorkspaces } from "~/workspace/others";
import type { OtherWorkspaces } from "~/workspace/snapshot";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { runTaskCommand } from "~/workspace/tasks";

export interface HostWorkspaceOptions {
  readonly artifacts: string;
  readonly askable?: boolean;
  readonly cwd?: string;
  readonly database?: MarblesDatabase;
  readonly directory?: string;
  readonly onClose?: (closing: Promise<void>) => void;
  readonly onMissing?: (configPath: string) => Promise<boolean>;
  readonly prepare?: (engine: Engine) => void;
  readonly print?: (line: string) => void;
  readonly read?: (file: string) => void;
  readonly source: string;
  readonly spawned?: string;
  readonly state: string;
}

export interface WorkspaceHost extends WorkspaceConnection {
  close(): Promise<void>;
  readonly configPath: string;
  readonly engine: Engine;
  readonly files: readonly string[];
  run(signal: AbortSignal, cancel?: AbortSignal): Promise<void>;
  setStatus(line: string): void;
  readonly status: string;
  readonly workspace: Workspace;
}

export interface GenerationHost extends WorkspaceHost {
  snapshot(elsewhere?: readonly LiveRun[]): Promise<DashboardSnapshot>;
}

class LaunchInputError extends Error {
  override readonly name = "LaunchInputError";
}

async function inputHint(
  engine: Engine,
  name: string,
  error: SchemaError
): Promise<string> {
  const fields =
    engine.definitions().find((entry) => entry.name === name)?.input.fields ??
    [];
  const takes = fields
    .map(
      (field) =>
        `${field.name} (${field.type}${field.required ? "" : ", optional"})`
    )
    .join(", ");
  const sample = JSON.stringify(
    Object.fromEntries(
      fields.filter((field) => field.required).map((field) => [field.name, "…"])
    )
  );
  const keys = (await engine.schedules())
    .filter((record) => record.workflow === name && record.input !== undefined)
    .map((record) => record.key);
  const carried =
    keys.length > 0
      ? `, or run a schedule key that carries it: ${keys.join(", ")}`
      : "";
  return [
    `${error.message}.`,
    takes === "" ? "" : `${name} takes ${takes}.`,
    `Pass --input '${sample}'${carried}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function hostWorkspace(
  options: HostWorkspaceOptions
): Promise<WorkspaceHost> {
  return await (await stageWorkspace(options)).start();
}

export interface StagedWorkspace {
  abandon(): Promise<void>;
  readonly config: string | null;
  readonly configPath: string;
  readonly files: readonly string[];
  readonly id: string;
  readonly root: string;
  start(): Promise<GenerationHost>;
}

export async function stageWorkspace(
  options: HostWorkspaceOptions
): Promise<StagedWorkspace> {
  expectHost();
  const captured = new AsyncLocalStorage<string[]>();
  let status = "Loading marbles";
  const diagnostics = new Diagnostics();
  const report = (line: string): void => {
    status = line;
    options.print?.(line);
    captured.getStore()?.push(line);
  };
  const { log, print } = hostOutput(diagnostics, report);
  const hostOptions = {
    artifacts: options.artifacts,
    config: options.source,
    ...(options.directory === undefined
      ? {}
      : { directory: options.directory }),
    ...(options.spawned === undefined ? {} : { spawned: options.spawned }),
    state: options.state,
  };
  const loaded = await openWorkspace(hostOptions, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    onMissing: options.onMissing,
    print,
    ...(options.read === undefined ? {} : { read: options.read }),
  });
  const shared = options.database;
  let own: MarblesDatabase | undefined;
  const unbind = (): void => {
    own?.close();
  };
  const release = async (built: Engine): Promise<void> => {
    try {
      await built.dispose();
    } finally {
      try {
        releaseEngine(built);
      } finally {
        unbind();
      }
    }
  };
  let engine: Engine;
  let opened: OpenedWorkspace;
  let dispatches: BackgroundRuns;
  try {
    own =
      shared === undefined
        ? await openHostDatabase(hostOptions.state)
        : undefined;
    opened = await asRegistered(
      shared ?? own,
      hostOptions,
      loaded,
      options.cwd
    );
    engine = await hostEngine(hostOptions, opened, {
      askable: options.askable,
      ...((shared ?? own) === undefined ? {} : { database: shared ?? own }),
      log,
      print,
    });
  } catch (error) {
    unbind();
    throw error;
  }
  try {
    options.prepare?.(engine);
    dispatches = new BackgroundRuns(engine, opened.catalog);
  } catch (error) {
    await release(engine);
    throw error;
  }
  const database = shared ?? own;
  let used = false;
  const once = (): void => {
    if (used) {
      throw new Error(
        `workspace ${opened.workspace.id} was started or abandoned already`
      );
    }
    used = true;
  };
  return {
    async abandon() {
      once();
      await release(engine);
    },
    config: opened.config,
    configPath: opened.configPath,
    files: opened.files,
    id: opened.workspace.id,
    root: opened.workspace.root,
    async start() {
      once();
      try {
        await engine.start();
        await touchWorkspace(
          database,
          hostOptions,
          opened,
          options.cwd === undefined ? {} : { cwd: options.cwd }
        );
        return hosted(engine, opened, dispatches, {
          captured,
          database: own,
          diagnostics,
          fail: (line) => {
            report(line);
            diagnostics.add(line, "error");
          },
          feed:
            database === undefined
              ? engine.feed
              : workspaceFeed({
                  artifacts: hostOptions.artifacts,
                  database: database.database,
                  own: engine.feed,
                  state: hostOptions.state,
                  workspace: opened.workspace.id,
                }),
          ...(database === undefined
            ? {}
            : {
                others: otherWorkspaces({
                  database: database.database,
                  state: hostOptions.state,
                  workspace: opened.workspace.id,
                }),
              }),
          ...(options.onClose === undefined
            ? {}
            : { onClose: options.onClose }),
          print,
          setStatus: (line) => {
            status = line;
          },
          status: () => status,
        });
      } catch (error) {
        await release(engine);
        throw error;
      }
    },
  };
}

interface Status {
  readonly captured: AsyncLocalStorage<string[]>;
  readonly database: MarblesDatabase | undefined;
  readonly diagnostics: Diagnostics;
  readonly fail: (line: string) => void;
  readonly feed: FeedReader;
  readonly onClose?: (closing: Promise<void>) => void;
  readonly others?: (now: number) => Promise<OtherWorkspaces>;
  readonly print: (line: string) => void;
  readonly setStatus: (line: string) => void;
  readonly status: () => string;
}

async function readUsage(
  engine: Engine,
  read: (error?: unknown) => void
): Promise<UsageRecords> {
  try {
    const records = await engine.readUsage();
    read();
    return records;
  } catch (error) {
    read(error);
  }
  try {
    const saved = await engine.usage.read();
    return {
      ...saved,
      unreadable: saved.unreadable + 1,
      unreadableAt: {
        ...saved.unreadableAt,
        unowned: saved.unreadableAt.unowned + 1,
      },
    };
  } catch {
    return {
      facts: [],
      recovered: 0,
      unreadable: 1,
      unreadableAt: { direct: 0, runs: new Map(), unowned: 1 },
      unsaved: 0,
      unsavedTurns: new Set(),
    };
  }
}

async function nextDues(
  engine: Engine
): Promise<ReadonlyMap<string, number | null>> {
  const due = new Map<string, number | null>();
  try {
    const store = await engine.triggers.schedules();
    for (const schedule of await engine.schedules()) {
      const cursor = await runStoreEffect(store.getCursor(schedule.key));
      if (cursor !== undefined) {
        due.set(schedule.key, cursor.nextDueAt);
      }
    }
  } catch {
    return due;
  }
  return due;
}

function hosted(
  engine: Engine,
  opened: OpenedWorkspace,
  dispatches: BackgroundRuns,
  {
    captured,
    database,
    diagnostics,
    fail,
    feed,
    onClose,
    others,
    print,
    setStatus,
    status,
  }: Status
): GenerationHost {
  const { catalog, config, configPath, workspace } = opened;
  const { activities, automations } = engine;
  const tasks = hostTasks(engine);
  const startedAt = Date.now();
  let usageFailure: string | undefined;
  const usageRead = (error?: unknown): void => {
    if (error === undefined) {
      usageFailure = undefined;
      return;
    }
    const line = `[usage] could not be read: ${String(error)}`;
    if (line !== usageFailure) {
      usageFailure = line;
      diagnostics.add(line, "error");
    }
  };
  const actions: WorkspaceActions = {
    async answer(entryId, answer) {
      await engine.answer(entryId, answer);
    },
    async launch(name, input) {
      if (!dispatches.definitions().some((entry) => entry.name === name)) {
        throw new Error("This definition is not available for manual launch.");
      }
      const launched = await engine.launch(name, inputFromFields(input ?? {}));
      launched.result.catch((error: unknown) => fail(`[run] ${String(error)}`));
      return launched.id;
    },
    runs: {
      cancel: (runId) => engine.cancel(runId),
      deleteTrigger: (id) => automations.delete(id),
      pause(runId, stepId) {
        if (!engine.pause(runId, stepId)) {
          throw new Error("This step is not running in this process.");
        }
        return Promise.resolve();
      },
      resume: (runId, stepId, prompt) => engine.resume(runId, stepId, prompt),
      send(runId, stepId, input) {
        engine.send(runId, stepId, input);
        return Promise.resolve();
      },
      async setTriggerEnabled(id, enabled) {
        await automations.setEnabled(id, enabled);
      },
      steer(runId, stepId, prompt) {
        engine.steer(runId, stepId, prompt);
        return Promise.resolve();
      },
      stopActivity: (sessionId, activityId) =>
        activities.stop(sessionId, activityId),
      stream: (runId, signal) => engine.stream(runId, signal),
    },
  };

  async function capture<T>(
    work: () => Promise<T>
  ): Promise<{ readonly lines: string[]; readonly value: T }> {
    const lines: string[] = [];
    const value = await captured.run(lines, work);
    return { lines, value };
  }

  let closing: Promise<void> | undefined;
  const shutDown = async () => {
    try {
      await dispatches.close();
    } finally {
      try {
        await engine.dispose();
      } finally {
        releaseEngine(engine);
        database?.close();
      }
    }
  };
  return {
    actions,
    cancelRun: (runId) => dispatches.cancel(runId),
    close() {
      if (closing === undefined) {
        closing = shutDown();
        onClose?.(closing);
      }
      return closing;
    },
    config,
    configPath,
    describe(): Promise<WorkspaceConfig> {
      return Promise.resolve({
        agents: [...catalog.agents.entries()].map(
          ([id, { model, provider }]) => ({
            id,
            ...(model === undefined ? {} : { model }),
            ...(provider === undefined ? {} : { provider }),
          })
        ),
        definitions: dispatches.definitions(),
        monitors: [...catalog.monitors.values()].map(
          ({ key, label, source, trigger }) => ({
            key,
            ...(label === undefined ? {} : { label }),
            source,
            trigger,
          })
        ),
        observers: catalog.observerEntries(),
        root: workspace.root,
        schedules: [...catalog.schedules.values()],
        source: config,
      });
    },
    dispatchAgent: (options: DispatchOptions): Promise<DispatchInfo> =>
      dispatches.start(options),
    dispatchWorkflow: (name, input, options): Promise<DispatchInfo> =>
      dispatches.startWorkflow(name, input, options),
    engine,
    files: opened.files,
    getRun: (runId): Promise<RunInfo> => dispatches.get(runId),
    id: workspace.id,
    listRuns: (query): Promise<RunPage> => dispatches.list(query),
    async roll(name, input): Promise<RollResult> {
      const schedule = (await engine.schedules()).find(
        (record) => record.key === name
      );
      const launchInput = input === undefined ? schedule?.input : input;
      if (schedule) {
        const { lines, value } = await capture(() =>
          rollSchedule(engine, { ...schedule, input: launchInput }, { print })
        );
        return { lines, ...value };
      }
      if (!dispatches.definitions().some((entry) => entry.name === name)) {
        throw new Error(
          `no step, workflow, schedule, or monitor named "${name}"`
        );
      }
      const { lines, value } = await capture(() =>
        engine.run<unknown>(name, launchInput).catch(async (error: unknown) => {
          throw error instanceof SchemaError
            ? new LaunchInputError(await inputHint(engine, name, error))
            : error;
        })
      );
      return { lines, value };
    },
    root: workspace.root,
    run: (signal, cancel) =>
      runSchedulesUntilStopped(engine, {
        ...(cancel === undefined ? {} : { cancel }),
        print,
        signal,
      }),
    setStatus,
    async snapshot(elsewhere): Promise<DashboardSnapshot> {
      const usage = await readUsage(engine, usageRead);
      const now = Date.now();
      const entries = await feed();
      const { records, work } = liveView(
        await engine.runs(),
        engine.scopes,
        elsewhere
      );
      return dashboardSnapshot(records, {
        activities: activities.list(),
        automationErrors: await automations.errors(),
        automations: await automations.list(),
        definitions: dispatches.definitions(),
        diagnostics: diagnostics.entries,
        feed: entries,
        live: work,
        monitors: engine.monitors(),
        nextDue: await nextDues(engine),
        now,
        ...(others === undefined ? {} : { others: await others(now) }),
        questionOwners: await questionOwners(engine.sessions, entries, work),
        queued: engine.executions.list(),
        root: workspace.root,
        schedules: await engine.schedules(),
        setupLogs: diagnostics.setupEntries,
        startedAt,
        status: status(),
        usage,
        workspaceId: workspace.id,
      });
    },
    get status() {
      return status();
    },
    tasks: (command) => runTaskCommand(tasks, command),
    workspace,
  };
}

export { LaunchInputError };
