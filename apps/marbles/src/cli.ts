#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { TaskError } from "@foundry/tasks";
import type { Args, ArgsOf, Command, Flags } from "~/args";
import { parseArgs, UsageError } from "~/args";
import type { Triggers } from "~/create";
import { layout } from "~/layout";
import { CLI_HARNESS_IDS } from "~/lib/cli-harnesses";
import type { Engine } from "~/lib/engine";
import { RunEndedError } from "~/lib/engine";
import { RecordsHeldError } from "~/lib/events/records";
import type { MonitorSpec } from "~/lib/monitor";
import { describeMonitor } from "~/lib/monitor";
import { describeTrigger } from "~/lib/schedule";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { RunOutputError } from "~/lib/state/output";
import { readWorkspace } from "~/lib/state/workspace";
import type { WorkspaceConnection } from "~/model/connection";
import type {
  TaskCommand,
  TaskCommandKind,
  TaskCommandResult,
} from "~/model/tasks";
import type { MarblesClient } from "~/process/client";
import {
  connect,
  describeDisconnect,
  NoProcessError,
  ProcessMismatchError,
  ProcessTimeoutError,
  stopProcess,
} from "~/process/client";
import { startDaemon } from "~/process/daemon";
import { ProcessHeldError } from "~/process/instance";
import { RemoteError } from "~/process/protocol";
import { sessionLines } from "~/sessions/list";
import { readStatus } from "~/status/model";
import { statusText } from "~/status/text";
import { taskCommandText } from "~/tasks/text";
import { watchRun } from "~/watch";
import { createStarter } from "~/workspace/create";
import { EnvironmentError } from "~/workspace/env";
import type { WorkspaceHost } from "~/workspace/host";
import { hostWorkspace, LaunchInputError } from "~/workspace/host";
import type { OpenedWorkspace } from "~/workspace/open";
import {
  findWorkspace,
  hostTasks,
  hostTriggers,
  openWorkspace,
  workspaceEngine,
} from "~/workspace/open";
import { resolveSource } from "~/workspace/source";
import { runTaskCommand } from "~/workspace/tasks";
import { DEFAULT_HARNESS, STARTERS } from "~/workspace/templates";

const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};
/** Diagnostics where a command's own output is data, such as `--json`. */
const diagnose = (line: string) => {
  process.stderr.write(`${line}\n`);
};

const USAGE = `marbles — programmable workspace automation

  [run]                      open the dashboard; piped, attach this workspace and follow it
  init [starter]             create a starter module (developer | design | product)
  help, --help, -h            show this help
  roll <name> [--input json] dispatch one workflow or schedule now, then exit
  list                       workflows, then each schedule and monitor with its cadence
  status                     the Marbles process and every workspace under --state
  sessions                   sessions under --state: id, messages, updated, summary
  tasks <action> [--json]    read or change this workspace's tasks (below)
  watch <runId>              replay output, follow it live, and exit when the run ends
  daemon                     run the Marbles process in the foreground
  stop                       stop the Marbles process and every workspace it hosts
  tasks <action> [--json]    read or change this workspace's tasks (below)
  attach                     host this workspace in the Marbles process and exit; it stays hosted
  detach                     stop hosting this workspace; it is not started again at boot

  --source <path>    authoring folder or module (default: ./.foundry/marbles)
  --config <path>    compatibility alias for --source
  --state <dir>      state root (default: ~/.foundry/marbles)
  --artifacts <dir>  artifact store holding the feed (default: artifacts/ beside the state root)
  --dry-run          echo every model turn and git mutation instead of running them
  --harness <id>     use only this harness (${CLI_HARNESS_IDS.join(" | ")}); repeatable

One Marbles process per machine hosts every attached workspace, each in a worker
of its own, and keeps their triggers running after the dashboard closes; run and
roll start it when none runs. Each workspace (the project above .foundry/marbles)
gets <state>/<id>/ holding workspace.json, runs/, output/, schedules/, locks/ and
sessions/. Feed entries from every workspace share the artifact store. --dry-run
hosts the workspace in this process instead, persists nothing, and echoes every
model turn and git mutation; custom code still runs.


Tasks, the workspace backlog (--json prints the result as JSON; --tag needs every tag given,
--any-tag one of them; on update, --tag replaces the tags):
  tasks list [--status <status>] [--parent <id> | --root] [--tag <tag>]... [--any-tag <tag>]...
             [--depth n] [--limit n] [--cursor n]
  tasks ready [--tag <tag>]... [--any-tag <tag>]... [--limit n] [--cursor n]
  tasks get <id> [--depth n]
  tasks deps <id>
  tasks create <title> [--description <text>] [--parent <id>] [--depends-on <id>]... [--tag <tag>]...
  tasks update <id> [--title <text>] [--description <text>] [--tag <tag>... | --clear-tags]
               [--expect <updatedAt>]
  tasks start | complete | cancel | reopen <id> [--expect <updatedAt>]
  tasks move <id> (--parent <id> | --root) [--expect <updatedAt>]
  tasks depend | undepend <id> <dependsOnId>
  tasks change --input '{"operations":[...]}'   one atomic batch of task operations
Tasks are kept with the workspace state (memory only under --dry-run). No source runs here:
a worker of the Marbles process that already hosts this workspace answers, else this command
opens the tasks itself; tasks never starts the process or a worker.`;

/**
 * What a command needs before it runs, each step a superset of the last:
 * `workspace` finds the source without executing it, `triggers` loads it
 * and reads what would run, `connection` runs against a hosted one.
 * `tasks` is beside them: the found workspace's tasks, from the worker that
 * already hosts it or through an engine this process never starts, so no
 * source runs and nothing is delivered here.
 */
type Handler<A extends Flags> =
  | { readonly needs: "nothing"; run(args: A): Promise<void> | void }
  | {
      readonly needs: "workspace";
      run(args: A, opened: OpenedWorkspace): Promise<void> | void;
    }
  | {
      readonly needs: "triggers";
      run(args: A, opened: OpenedWorkspace, triggers: Triggers): void;
    }
  | {
      /**
       * The command runs against a hosted workspace: by the Marbles process,
       * or in this process under `--dry-run`.
       */
      readonly needs: "connection";
      run(args: A, hosted: Hosted): Promise<void>;
    }
  | { readonly needs: "tasks"; run(args: A, tasks: TaskRunner): Promise<void> };

/** Runs one task command on the workspace's own tasks; a refusal is a `TaskError`. */
type TaskRunner = <K extends TaskCommandKind>(
  command: TaskCommand<K>
) => Promise<TaskCommandResult<K>>;

/** Where the workspace a command runs against is hosted. */
type Hosted =
  | { readonly kind: "local"; readonly host: WorkspaceHost }
  | {
      readonly kind: "remote";
      readonly client: MarblesClient;
      readonly id: string;
      readonly workspace: WorkspaceConnection;
    };

async function createStarterModule(args: ArgsOf<"init">): Promise<void> {
  const starter = STARTERS.find((item) => item.id === args.starter);
  if (!starter) {
    throw new Error(`no starter "${args.starter}"`);
  }
  const file = await createStarter(resolve(args.config), {
    harness: DEFAULT_HARNESS,
    instructions: "",
    name: starter.name,
    template: starter.id,
  });
  print(`Created ${file}`);
}

/** Reads files only: an empty state root stays empty. */
async function showStatus(
  args: Args,
  { workspace }: OpenedWorkspace
): Promise<void> {
  const report = readStatus(resolve(args.state));
  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { showStatus: renderStatus } = await import("~/status/view");
    await renderStatus({ here: workspace.id, report });
    return;
  }
  print(statusText(report, workspace.id));
}

async function listSessions(
  _args: Args,
  { workspace }: OpenedWorkspace
): Promise<void> {
  const dir = join(workspace.dir, "sessions");
  // The store mkdirs on construction; a listing must not leave one behind.
  if (!existsSync(dir)) {
    return;
  }
  for (const line of await sessionLines(new JsonSessionStore(dir))) {
    print(line);
  }
}

function listTriggers(
  _args: Args,
  _opened: OpenedWorkspace,
  triggers: Triggers
): void {
  const { automations, registry } = triggers;
  const created = new Map(
    automations.list().map((record) => [record.id, record.source])
  );
  /** What a monitor schedule watches: declared in the config, or by an agent. */
  const watched = (key: string): MonitorSpec | undefined =>
    registry.monitors.get(key)?.source ?? created.get(key);
  for (const entry of registry.entries()) {
    print(`[${entry.kind}] ${entry.name}`);
  }
  for (const schedule of automations.schedules()) {
    const source =
      schedule.kind === "monitor" ? watched(schedule.key) : undefined;
    if (source) {
      print(
        `[monitor] ${schedule.key} ${describeMonitor(source)} ${describeTrigger(schedule.trigger)}`
      );
    } else {
      const input =
        schedule.input === null ? "" : ` ${JSON.stringify(schedule.input)}`;
      print(
        `[schedule] ${schedule.key} → ${schedule.workflow}${input} ${describeTrigger(schedule.trigger)}`
      );
    }
  }
}

/** `--input` as JSON; anything else is a usage error that names the flag. */
function inputFrom(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new UsageError(
      `--input is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

async function roll(args: ArgsOf<"roll">, hosted: Hosted): Promise<void> {
  const input: unknown =
    args.inputJson === undefined ? undefined : inputFrom(args.inputJson);
  const workspace = hosted.kind === "local" ? hosted.host : hosted.workspace;
  // A local host prints lines as they happen; a worker's come back with the value.
  const result = await workspace.roll(args.name, input);
  if (hosted.kind === "remote") {
    for (const line of result.lines) {
      print(line);
    }
  }
  if ("value" in result) {
    print(JSON.stringify(result.value, null, 2));
  }
}

async function runTasks(
  args: ArgsOf<"tasks">,
  tasks: TaskRunner
): Promise<void> {
  let result: TaskCommandResult;
  try {
    result = await tasks(args.task);
  } catch (error) {
    // A refusal, or tasks another process owns, is the person's to act on:
    // one line, a refusal with its stable code.
    if (error instanceof TaskError) {
      diagnose(`marbles: ${error.message} (${error.code})`);
    } else if (error instanceof RecordsHeldError) {
      diagnose(`marbles: ${error.message}`);
    } else {
      throw error;
    }
    process.exitCode = 1;
    return;
  }
  print(
    args.json
      ? JSON.stringify(result, null, 2)
      : taskCommandText(args.task, result)
  );
}

/** Resolves on SIGINT or SIGTERM, once. */
function interrupted(): { readonly done: Promise<void>; release(): void } {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((settle) => {
    finish = settle;
  });
  const stop = () => finish();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    done,
    release() {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    },
  };
}

/**
 * Headless `run`: under `--dry-run`, tick this process's triggers until
 * interrupted. Otherwise the workspace is attached to the Marbles process,
 * which keeps hosting it; this command follows its status lines until
 * interrupted, and detaching stops nothing.
 */
async function runUntilStopped(_args: Args, hosted: Hosted): Promise<void> {
  const signal = interrupted();
  try {
    if (hosted.kind === "local") {
      const controller = new AbortController();
      signal.done.then(() => controller.abort()).catch(() => undefined);
      await hosted.host.run(controller.signal);
      return;
    }
    const { client, id, workspace } = hosted;
    print(
      `[process] pid ${String(client.hello.pid)} hosts ${workspace.root} (${id}); Ctrl+C detaches and leaves it running`
    );
    const unsubscribe = client.subscribe(id, {
      line: print,
      workspace(summary) {
        print(
          `[workspace] ${summary.state}${summary.error ? `: ${summary.error}` : ""}`
        );
      },
    });
    try {
      const ended = await Promise.race([
        signal.done.then(() => "interrupted" as const),
        client.closed,
      ]);
      if (ended === "interrupted") {
        return;
      }
      // The daemon went first: say why, since nothing else here will. Only
      // a stop it was asked for is a clean end of this command.
      print(`[process] ${describeDisconnect(ended)}`);
      if (ended.kind !== "stopped") {
        process.exitCode = 1;
      }
    } finally {
      unsubscribe();
    }
  } finally {
    signal.release();
  }
}

/** The Marbles process in the foreground, until interrupted. */
async function runDaemon(args: ArgsOf<"daemon">): Promise<void> {
  const daemon = await startDaemon({
    layout: layout({ artifacts: args.artifacts, state: args.state }),
    only: args.only,
    print,
  });
  const signal = interrupted();
  try {
    await Promise.race([signal.done, daemon.closed]);
  } finally {
    signal.release();
    await daemon.close();
  }
}

/** Host this workspace in the Marbles process, starting one when none runs, and leave it there. */
async function attachWorkspace(args: ArgsOf<"attach">): Promise<void> {
  if (args.dry) {
    throw new UsageError(
      "attach hosts the workspace in the Marbles process; it takes no --dry-run"
    );
  }
  await withProcess(args, (hosted) => {
    if (hosted.kind === "remote") {
      print(
        `[process] pid ${String(hosted.client.hello.pid)} hosts ${hosted.workspace.root} (${hosted.id})`
      );
    }
    return Promise.resolve();
  });
}

/**
 * Stop hosting this workspace: its worker drains, and the Marbles process
 * does not start it again at boot. Without a process, only the record is
 * cleared, and a workspace never recorded is left alone.
 */
async function detachWorkspace(
  args: ArgsOf<"detach">,
  opened: OpenedWorkspace
): Promise<void> {
  const { config, workspace } = opened;
  const where = `${workspace.root} (${workspace.id})`;
  const forget = (): void => {
    if (readWorkspace(workspace.dir)?.hosted === true) {
      workspace.touch(config, { hosted: false });
    }
  };
  let client: MarblesClient;
  try {
    client = await connect({
      layout: layout({ artifacts: args.artifacts, state: args.state }),
      start: false,
    });
  } catch (error) {
    if (!(error instanceof NoProcessError)) {
      throw error;
    }
    forget();
    print(`no Marbles process is running; ${where} is not hosted`);
    return;
  }
  try {
    const summaries = await client.workspaces();
    if (summaries.some((summary) => summary.id === workspace.id)) {
      await client.detach(workspace.id);
      print(
        `detached ${where} from Marbles process pid ${String(client.hello.pid)}`
      );
    } else {
      forget();
      print(`${where} is not hosted`);
    }
  } finally {
    client.close();
  }
}

/** Stop the Marbles process, whatever version it runs, and return once it has exited. */
async function stopDaemon(args: ArgsOf<"stop">): Promise<void> {
  const stopped = await stopProcess({
    layout: layout({ artifacts: args.artifacts, state: args.state }),
    // Draining can take a while when a run is mid-flight; say so up front.
    onStopping: (hello) =>
      print(
        `stopping Marbles process pid ${String(hello.pid)}; waiting for its workers to drain`
      ),
  });
  print(
    stopped === undefined
      ? "no Marbles process is running"
      : `stopped Marbles process pid ${String(stopped.pid)}`
  );
}

async function watch(args: ArgsOf<"watch">): Promise<void> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const status = await watchRun(resolve(args.state), args.runId, {
      signal: controller.signal,
      write: (text) => {
        process.stdout.write(text);
      },
    });
    if (status !== "completed") {
      process.exitCode = 1;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

const COMMANDS: { readonly [C in Command]: Handler<ArgsOf<C>> } = {
  attach: { needs: "nothing", run: attachWorkspace },
  daemon: { needs: "nothing", run: runDaemon },
  detach: { needs: "workspace", run: detachWorkspace },
  help: { needs: "nothing", run: () => print(USAGE) },
  init: { needs: "nothing", run: createStarterModule },
  list: { needs: "triggers", run: listTriggers },
  roll: { needs: "connection", run: roll },
  run: { needs: "connection", run: runUntilStopped },
  sessions: { needs: "workspace", run: listSessions },
  status: { needs: "workspace", run: showStatus },
  stop: { needs: "nothing", run: stopDaemon },
  tasks: { needs: "tasks", run: runTasks },
  watch: { needs: "nothing", run: watch },
};

async function printNewRuns(engine: Engine, restored: ReadonlySet<string>) {
  for (const record of await engine.runs()) {
    if (!restored.has(record.id)) {
      print(`[run] ${record.step} ${record.status} ${record.id}`);
    }
  }
}

/** Agent-created triggers that cannot run, by id, and why. */
function printErrors(automations: Triggers["automations"]): void {
  for (const [id, error] of Object.entries(automations.errors())) {
    print(`[automation] ${id}: ${error}`);
  }
}

/** One-shot execution requires its environment; `run` and listing only warn. */
function envMode(args: { readonly command: Command }): "require" | "warn" {
  return args.command === "roll" ? "require" : "warn";
}

/** Host the workspace in this process; only `--dry-run` does. */
async function withLocalHost(
  args: Flags & { readonly command: Command },
  run: (hosted: Hosted) => Promise<void>
): Promise<void> {
  const host = await hostWorkspace({
    artifacts: args.artifacts,
    dry: args.dry,
    env: envMode(args),
    only: args.only,
    print,
    source: args.config,
    state: args.state,
  });
  const { engine } = host;
  try {
    printErrors(engine.automations);
    print(`[harnesses] ${engine.harnesses.join(", ")}`);
    const restored = new Set((await engine.runs()).map((record) => record.id));
    await run({ host, kind: "local" });
    await printNewRuns(engine, restored);
  } finally {
    await host.close();
  }
}

/** Attach the workspace to the Marbles process, starting one when none runs. */
async function withProcess(
  args: Flags,
  run: (hosted: Hosted) => Promise<void>
): Promise<void> {
  const client = await connect({
    layout: layout({ artifacts: args.artifacts, state: args.state }),
    only: args.only,
  });
  try {
    const summary = await client.attach(resolveSource(args.config), {
      root: process.cwd(),
    });
    await run({
      client,
      id: summary.id,
      kind: "remote",
      workspace: client.workspace(summary),
    });
  } finally {
    client.close();
  }
}

/**
 * The worker that hosts the workspace now, when a Marbles process runs and
 * has it ready. Nothing is started or attached to find out. A worker that
 * is starting is about to own the tasks, so the command is refused rather
 * than racing it for them.
 */
async function hostingWorker(
  args: Flags,
  id: string
): Promise<
  | { readonly client: MarblesClient; readonly workspace: WorkspaceConnection }
  | undefined
> {
  let client: MarblesClient;
  try {
    client = await connect({
      layout: layout({ artifacts: args.artifacts, state: args.state }),
      start: false,
    });
  } catch (error) {
    if (error instanceof NoProcessError) {
      return undefined;
    }
    throw error;
  }
  try {
    const summary = (await client.workspaces()).find(
      (entry) => entry.id === id
    );
    if (summary?.state === "ready") {
      return { client, workspace: client.workspace(summary) };
    }
    if (summary?.state === "starting" || summary?.state === "reloading") {
      throw new RecordsHeldError(
        `the tasks of this workspace are about to be in use by Marbles process pid ${String(client.hello.pid)}, whose worker is ${summary.state}; retry once it is ready`
      );
    }
  } catch (error) {
    client.close();
    throw error;
  }
  client.close();
  return undefined;
}

/**
 * The workspace's tasks, without running its source here or starting
 * anything that would. A worker that already hosts the workspace owns
 * them, so each command goes to it. Otherwise this process opens them
 * through an engine it never starts, and gives them up when done; under
 * `--dry-run` they are in memory, and records another process owns are
 * refused, never answered from memory.
 */
async function withTasks(
  args: Flags,
  work: (tasks: TaskRunner) => Promise<void>
): Promise<void> {
  const opened = findWorkspace(args);
  const hosted = args.dry
    ? undefined
    : await hostingWorker(args, opened.workspace.id);
  if (hosted !== undefined) {
    try {
      await work((command) => hosted.workspace.tasks(command));
    } finally {
      hosted.client.close();
    }
    return;
  }
  const engine = workspaceEngine(args, opened, { print: diagnose });
  try {
    const tasks = hostTasks(engine);
    await work((command) => runTaskCommand(tasks, command));
  } finally {
    // Gives up the workspace's tasks for the next process.
    await engine.dispose();
  }
}

async function dispatch<C extends Command>(
  command: C,
  args: ArgsOf<C>
): Promise<void> {
  const handler: Handler<ArgsOf<C>> = COMMANDS[command];
  switch (handler.needs) {
    case "nothing":
      await handler.run(args);
      return;
    case "workspace":
      await handler.run(args, findWorkspace(args));
      return;
    case "triggers": {
      const opened = await openWorkspace(args, { env: envMode(args), print });
      const triggers = hostTriggers(args, opened);
      printErrors(triggers.automations);
      handler.run(args, opened, triggers);
      return;
    }
    case "connection":
      await (args.dry ? withLocalHost : withProcess)(args, (hosted) =>
        handler.run(args, hosted)
      );
      return;
    case "tasks":
      await withTasks(args, (tasks) => handler.run(args, tasks));
      return;
    default:
      throw new Error(`no handler for ${String(handler satisfies never)}`);
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.command === "run" && process.stdout.isTTY && process.stdin.isTTY) {
    const { runInteractive } = await import("~/dashboard/command");
    await runInteractive(args);
    return;
  }
  try {
    await dispatch(args.command, args);
  } catch (error) {
    // What the person running the command can act on reads as one line.
    if (
      !(
        error instanceof UsageError ||
        error instanceof EnvironmentError ||
        error instanceof LaunchInputError ||
        error instanceof NoProcessError ||
        error instanceof ProcessMismatchError ||
        error instanceof ProcessTimeoutError ||
        error instanceof ProcessHeldError ||
        error instanceof RecordsHeldError ||
        error instanceof RemoteError ||
        error instanceof RunEndedError ||
        error instanceof RunOutputError
      )
    ) {
      throw error;
    }
    process.stderr.write(`marbles: ${error.message}\n`);
    process.exitCode = 1;
  }
}

await main();
