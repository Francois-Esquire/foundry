import { AsyncLocalStorage } from "node:async_hooks";

import type { MarblesDatabase } from "~/database/open";
import { openHostDatabase } from "~/database/workspaces";
import type { Engine } from "~/lib/engine";
import { tick } from "~/lib/schedule";
import { inputFromFields, SchemaError } from "~/lib/schema";
import type { Workspace } from "~/lib/state/workspace";
import { finishedAt } from "~/lib/trigger-store";
import type { UsageRecords } from "~/lib/usage";
import type {
  DispatchInfo,
  DispatchOptions,
  RollResult,
  RunInfo,
  WorkspaceActions,
  WorkspaceConfig,
  WorkspaceConnection,
} from "~/model/connection";
import type { DashboardSnapshot } from "~/model/dashboard";
import { BackgroundRuns } from "~/workspace/background-runs";
import { Diagnostics, hostOutput } from "~/workspace/diagnostics";
import { runSchedulesUntilStopped } from "~/workspace/loop";
import type { OpenedWorkspace } from "~/workspace/open";
import {
  hostEngine,
  hostTasks,
  openWorkspace,
  touchWorkspace,
} from "~/workspace/open";
import { dashboardSnapshot } from "~/workspace/snapshot";
import { runTaskCommand } from "~/workspace/tasks";

/**
 * One workspace, hosted in this process: its source loaded, its engine
 * built and started, and everything a host does with it behind the
 * `WorkspaceConnection` the dashboard, the CLI, and MCP are written
 * against. The Marbles process runs one of these per workspace in a worker;
 * a program that embeds Marbles for a single workspace runs it directly.
 */

export interface HostWorkspaceOptions {
  /** The shared artifact store. */
  readonly artifacts: string;
  /** Whether something here can answer `ask`; the dashboard can. */
  readonly askable?: boolean;
  /** Where the workspace's runs start and its commands run; its root when omitted. */
  readonly cwd?: string;
  /**
   * The Marbles database this host writes through, for a host that keeps
   * several workspaces over one handle; the host leaves it open. Without
   * one, the host opens its own (`openHostDatabase`) and closes it with the
   * engine.
   */
  readonly database?: MarblesDatabase;
  /**
   * The directory the host runs from: a relative `source` resolves from
   * it, and it is the workspace's root when nothing is at the source.
   * Needed for either; without it `source` must be absolute and there.
   */
  readonly directory?: string;
  /** Echo every model turn and git mutation, and persist nothing. */
  readonly dry?: boolean;
  /** What a `.env.schema` that does not resolve does; `warn` when omitted. */
  readonly env?: "require" | "warn";
  /** Nothing is at the source: offer to create it. Resolves true once something loads there. */
  readonly onMissing?: (configPath: string) => Promise<boolean>;
  /** Runs on the built engine before it starts: host steps registered beside the source. */
  readonly prepare?: (engine: Engine) => void;
  /** Receives each status line; the last one is the host's `status`. */
  readonly print?: (line: string) => void;
  /** The authoring folder or module. */
  readonly source: string;
  /** The Marbles state root. */
  readonly state: string;
}

export interface WorkspaceHost extends WorkspaceConnection {
  /** Stop the engine, cancelling live runs, and close what it opened. */
  close(): Promise<void>;
  /** Where the source is, or would be created. */
  readonly configPath: string;
  readonly engine: Engine;
  /** Tick the live triggers until `signal` aborts. */
  run(signal: AbortSignal): Promise<void>;
  setStatus(line: string): void;
  /** The last status line; shown in the dashboard's toolbar. */
  readonly status: string;
  readonly workspace: Workspace;
}

class LaunchInputError extends Error {
  override readonly name = "LaunchInputError";
}

/** A rejected launch input in one line: what the definition takes, and where to get it. */
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
      ? `, or roll a schedule key that carries it: ${keys.join(", ")}`
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
  // The lines of the call printing them: overlapping rolls, and the
  // schedule loop beside them, each keep their own.
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
    dry: options.dry ?? false,
    state: options.state,
  };
  const opened = await openWorkspace(hostOptions, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    onMissing: options.onMissing,
    print,
  });
  // A host is a writer, and keeps one handle for as long as it hosts: it
  // makes and migrates the database only under the state root's process
  // lock (`openHostDatabase`). Under `--dry-run` nothing is persisted.
  const shared = hostOptions.dry ? undefined : options.database;
  const own =
    hostOptions.dry || shared !== undefined
      ? undefined
      : await openHostDatabase(hostOptions.state);
  const database = shared ?? own;
  try {
    const engine = await hostEngine(hostOptions, opened, {
      askable: options.askable,
      ...(database === undefined ? {} : { database }),
      log,
      print,
    });
    try {
      options.prepare?.(engine);
      // Defined before the engine starts: background agent dispatch is a step.
      const dispatches = new BackgroundRuns(engine, opened.catalog);
      await engine.start();
      await touchWorkspace(database, hostOptions, opened);
      return hosted(engine, opened, dispatches, {
        captured,
        database: own,
        diagnostics,
        fail: (line) => {
          report(line);
          diagnostics.add(line, "error");
        },
        lastFinish: await lastFinishes(engine),
        print,
        setStatus: (line) => {
          status = line;
        },
        status: () => status,
      });
    } catch (error) {
      await engine.dispose();
      throw error;
    }
  } catch (error) {
    own?.close();
    throw error;
  }
}

interface Status {
  readonly captured: AsyncLocalStorage<string[]>;
  /** The handle on the Marbles database the host opened itself, closed once the engine is disposed. */
  readonly database: MarblesDatabase | undefined;
  readonly diagnostics: Diagnostics;
  /** An error line: the status, and an error in the Logs tab. */
  readonly fail: (line: string) => void;
  /** When each trigger last finished a tick, as the host started. */
  readonly lastFinish: ReadonlyMap<string, number>;
  readonly print: (line: string) => void;
  readonly setStatus: (line: string) => void;
  readonly status: () => string;
}

/**
 * What agent turns consumed, as much of it as can be read: a usage read
 * that fails must not take the runs, Logs and Feed down with it. The part
 * that failed counts as one unowned unreadable record, as a session listing
 * that fails does, so every total it may belong to says it is incomplete
 * rather than showing nothing or zero. Nothing is cached: the next snapshot
 * reads again. `read` hears each attempt: no error when it succeeded.
 */
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
    // The saved facts alone, without what the transcripts would recover.
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

/**
 * When each of the engine's triggers last finished a tick; one whose state
 * cannot be read is left out, as one that has never ticked is.
 */
async function lastFinishes(
  engine: Engine
): Promise<ReadonlyMap<string, number>> {
  const finished = new Map<string, number>();
  for (const schedule of await engine.schedules()) {
    const finish = finishedAt(
      await engine.triggers.lastTick(schedule.key).catch(() => undefined)
    );
    if (finish !== undefined) {
      finished.set(schedule.key, finish);
    }
  }
  return finished;
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
    lastFinish,
    print,
    setStatus,
    status,
  }: Status
): WorkspaceHost {
  const { catalog, config, configPath, workspace } = opened;
  const { activities, automations } = engine;
  const tasks = hostTasks(engine);
  const startedAt = Date.now();
  // Each poll would repeat it: a usage read failure is logged when it
  // starts or changes, and again if it comes back after a read succeeds.
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
      // The factory is the one parser: it validates at dispatch, a bad
      // value rejects the launch, and a transform runs once.
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

  /** Lines `work` printed, with its value. */
  async function capture<T>(
    work: () => Promise<T>
  ): Promise<{ readonly lines: string[]; readonly value: T }> {
    const lines: string[] = [];
    const value = await captured.run(lines, work);
    return { lines, value };
  }

  return {
    actions,
    cancelRun: (runId) => dispatches.cancel(runId),
    async close() {
      try {
        await dispatches.close();
      } finally {
        try {
          await engine.dispose();
        } finally {
          database?.close();
        }
      }
    },
    config,
    configPath,
    describe(): Promise<WorkspaceConfig> {
      return Promise.resolve({
        agents: [...catalog.agents.values()].map(({ id, model, provider }) => ({
          id,
          ...(model === undefined ? {} : { model }),
          ...(provider === undefined ? {} : { provider }),
        })),
        definitions: dispatches.definitions(),
        monitors: [...catalog.monitors.values()].map(
          ({ key, label, source, trigger }) => ({
            key,
            ...(label === undefined ? {} : { label }),
            source,
            trigger,
          })
        ),
        root: workspace.root,
        schedules: [...catalog.schedules.values()],
        source: config,
      });
    },
    dispatchAgent: (options: DispatchOptions): Promise<DispatchInfo> =>
      dispatches.start(options),
    dispatchWorkflow: (name, input): Promise<DispatchInfo> =>
      dispatches.startWorkflow(name, input),
    engine,
    getRun: (runId): Promise<RunInfo> => dispatches.get(runId),
    id: workspace.id,
    async roll(name, input): Promise<RollResult> {
      const schedule = (await engine.schedules()).find(
        (record) => record.key === name
      );
      const launchInput = input === undefined ? schedule?.input : input;
      if (schedule) {
        const { lines, value } = await capture(() =>
          tick(engine, { ...schedule, input: launchInput }, { print })
        );
        return value === undefined ? { lines } : { lines, value: value.value };
      }
      if (!dispatches.definitions().some((entry) => entry.name === name)) {
        throw new Error(`no workflow or schedule named "${name}"`);
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
    run: (signal) => runSchedulesUntilStopped(engine, { print, signal }),
    setStatus,
    async snapshot(): Promise<DashboardSnapshot> {
      // First, so a failure it logs is in this snapshot's diagnostics.
      const usage = await readUsage(engine, usageRead);
      return dashboardSnapshot(await engine.runs(), {
        activities: activities.list(),
        automationErrors: await automations.errors(),
        automations: await automations.list(),
        definitions: dispatches.definitions(),
        diagnostics: diagnostics.entries,
        feed: await engine.feed(),
        lastFinish,
        monitors: engine.monitors(),
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
