import { AsyncLocalStorage } from "node:async_hooks";

import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import { tick } from "~/lib/schedule";
import { inputFromFields, SchemaError } from "~/lib/schema";
import { lastFinish as recordedFinish } from "~/lib/state/schedules";
import type { Workspace } from "~/lib/state/workspace";
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
  /** Echo every model turn and git mutation, and persist nothing. */
  readonly dry?: boolean;
  /** What a `.env.schema` that does not resolve does; `warn` when omitted. */
  readonly env?: "require" | "warn";
  /** Harness ids to keep; empty keeps every detected one. */
  readonly only?: readonly string[];
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
function inputHint(engine: Engine, name: string, error: SchemaError): string {
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
  const keys = engine
    .schedules()
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

/** Open the source, build and start the engine, and host the workspace. */
export async function hostWorkspace(
  options: HostWorkspaceOptions
): Promise<WorkspaceHost> {
  // The lines of the call printing them: overlapping rolls, and the
  // schedule loop beside them, each keep their own.
  const captured = new AsyncLocalStorage<string[]>();
  let status = "Loading marbles";
  // Kept for the dashboard's Logs tab while this host runs.
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
    dry: options.dry ?? false,
    only: options.only ?? [],
    state: options.state,
  };
  const opened = await openWorkspace(hostOptions, {
    env: options.env,
    onMissing: options.onMissing,
    print,
  });
  const engine = await hostEngine(hostOptions, opened, {
    askable: options.askable,
    log,
    print,
  });
  try {
    options.prepare?.(engine);
    // Defined before the engine starts: background agent dispatch is a step.
    const dispatches = new BackgroundRuns(engine, catalog);
    await engine.start();
    touchWorkspace(engine, opened);
    return hosted(engine, opened, dispatches, {
      captured,
      diagnostics,
      fail: (line) => {
        report(line);
        diagnostics.add(line, "error");
      },
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
}

interface Status {
  readonly captured: AsyncLocalStorage<string[]>;
  readonly diagnostics: Diagnostics;
  /** An error line: the status, and an error in the Logs tab. */
  readonly fail: (line: string) => void;
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
    const saved = engine.usage.read();
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

function hosted(
  engine: Engine,
  opened: OpenedWorkspace,
  dispatches: BackgroundRuns,
  { captured, diagnostics, fail, print, setStatus, status }: Status
): WorkspaceHost {
  const { config, configPath, workspace } = opened;
  const { activities, automations, store } = engine;
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
  const lastFinish = new Map(
    engine.schedules().flatMap((schedule) => {
      const finish = recordedFinish(store, schedule.key);
      return finish === undefined ? [] : [[schedule.key, finish] as const];
    })
  );
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
      deleteTrigger(id) {
        automations.delete(id);
        return Promise.resolve();
      },
      pause(runId, stepId) {
        if (!engine.pause(runId, stepId)) {
          throw new Error("This step is not running in this process.");
        }
        return Promise.resolve();
      },
      resume: (runId, stepId, prompt) => engine.resume(runId, stepId, prompt),
      setTriggerEnabled(id, enabled) {
        automations.setEnabled(id, enabled);
        return Promise.resolve();
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
        await engine.dispose();
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
      const schedule = engine.schedules().find((record) => record.key === name);
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
        engine.run<unknown>(name, launchInput).catch((error: unknown) => {
          throw error instanceof SchemaError
            ? new LaunchInputError(inputHint(engine, name, error))
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
        automationErrors: automations.errors(),
        automations: automations.list(),
        definitions: dispatches.definitions(),
        diagnostics: diagnostics.entries,
        feed: await engine.feed(),
        lastFinish,
        monitors: engine.monitors(),
        root: workspace.root,
        schedules: engine.schedules(),
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
