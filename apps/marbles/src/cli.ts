#!/usr/bin/env bun
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ReentrantCallError } from "@foundry/lib/turns";
import { TaskError } from "@foundry/tasks";
import type { Hosted, TaskRunner } from "~/access/workspace";
import {
  attachToProcess,
  hostHere,
  joinProcess,
  NotHostedError,
  RecordsHeldError,
  withTasks,
} from "~/access/workspace";
import type { Args, ArgsOf, Command, Flags } from "~/args";
import { parseArgs, UsageError } from "~/args";
import type { Triggers } from "~/create";
import { DatabaseBusyError } from "~/database/client";
import { IncompatibleDatabaseError } from "~/database/migrate";
import { UnreadableDatabaseError, writeDatabase } from "~/database/open";
import { TaskStorageError } from "~/database/tasks";
import { WorkspaceRegistry } from "~/database/workspaces";
import { layout, stateDatabase } from "~/layout";
import type { Engine } from "~/lib/engine";
import { RunEndedError } from "~/lib/engine";
import type { MonitorSpec } from "~/lib/monitor";
import { describeMonitor } from "~/lib/monitor";
import { ConfigurationError } from "~/lib/providers/store";
import type { ResourceKind } from "~/lib/resources";
import { ResourceAssociationError } from "~/lib/resources";
import { describeTrigger } from "~/lib/schedule";
import { RunOutputError } from "~/lib/state/output";
import type { TaskCommandResult } from "~/model/tasks";
import {
  describeDisconnect,
  NoProcessError,
  ProcessMismatchError,
  ProcessTimeoutError,
  stopProcess,
} from "~/process/client";
import { startDaemon } from "~/process/daemon";
import { ProcessHeldError } from "~/process/instance";
import { RemoteError } from "~/process/protocol";
import { envFilesLoaded } from "~/process/runtime";
import type { ResourceCommandContext } from "~/resources/commands";
import { changeAssociation, listResources, relink } from "~/resources/commands";
import { LinksPlacementError } from "~/resources/links";
import { readStatus } from "~/status/model";
import { statusText } from "~/status/text";
import { taskCommandText } from "~/tasks/text";
import { watchRun } from "~/watch";
import { createStarter } from "~/workspace/create";
import { EnvironmentError } from "~/workspace/env";
import { LaunchInputError } from "~/workspace/host";
import type { OpenedWorkspace } from "~/workspace/open";
import { findWorkspace, hostTriggers, openWorkspace } from "~/workspace/open";
import { setupProviders } from "~/workspace/provider-setup";
import { STARTERS } from "~/workspace/templates";

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
  status                     the Marbles process and every workspace it has run
  runs [--all]               workflow runs, each with its steps; --all: every workspace's
  sessions [--all]           agent sessions: id, messages, updated, summary
  artifacts [--all]          artifacts: id, name, type, status, updated
  sandboxes [--all]          sandbox containers: id, status, created
  modules [--all]            modules: id and the artifact behind it
  share <kind> <id> <dir>    show one of this workspace's resources in the workspace at <dir> too
  unshare <kind> <id> <dir>  stop showing it there; the resource itself stays
  relink [--all]             rebuild .marbles/ links to this workspace's artifact files from the database
  tasks <action> [--json]    read or change this workspace's tasks (below)
  watch <runId>              replay output, follow it live, and exit when the run ends
  mcp                        serve this workspace to an MCP client over stdio; starts and hosts nothing
  daemon                     run the Marbles process in the foreground
  stop                       stop the Marbles process and every workspace it hosts
  attach                     host this workspace in the Marbles process and exit; it stays hosted
  detach                     stop hosting this workspace; it is not started again at boot

  --source <path>    authoring folder or module (default: ./.foundry/marbles)
  --config <path>    compatibility alias for --source
  --dry-run          echo every model turn and git mutation instead of running them

One Marbles process per machine hosts every attached workspace, each in a worker
of its own, and keeps their triggers running after the dashboard closes; run and
roll start it when none runs. Everything lives under the Foundry home
($FOUNDRY_HOME, else ~/.foundry): every workspace's record, tasks, agent
sessions, runs, providers and the rest in marbles/marbles.db; each workspace
(the project above .foundry/marbles) gets marbles/<id>/ for its run output and
worktrees; artifact files are under artifacts/. Each resource (run, session, artifact,
sandbox, module) belongs to the workspace it was made in and can be shared with others;
the listings show this workspace's own and shared resources, or with --all every
workspace's. .marbles/ in a workspace holds links to its artifact files, rebuilt by
relink from the database. --dry-run
hosts the workspace in this process instead, persists nothing, and echoes every
model turn and git mutation; custom code still runs.


Tasks, the workspace backlog (--json prints the result as JSON; --tag needs every tag given,
--any-tag one of them; on update, --tag replaces the tags and --metadata sets its keys over the
stored ones, where a null value removes a key):
  tasks list [--status <status>] [--parent <id> | --root] [--tag <tag>]... [--any-tag <tag>]...
             [--depth n] [--limit n] [--cursor n]
  tasks ready [--tag <tag>]... [--any-tag <tag>]... [--limit n] [--cursor n]
  tasks get <id> [--depth n]
  tasks deps <id>
  tasks create <title> [--description <text>] [--metadata <json>] [--parent <id>] [--depends-on <id>]... [--tag <tag>]...
  tasks update <id> [--title <text>] [--description <text>] [--metadata <json>] [--tag <tag>... | --clear-tags]
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
      run(
        args: A,
        opened: OpenedWorkspace,
        triggers: Triggers
      ): Promise<void> | void;
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

async function createStarterModule(args: ArgsOf<"init">): Promise<void> {
  const starter = STARTERS.find((item) => item.id === args.starter);
  if (!starter) {
    throw new Error(`no starter "${args.starter}"`);
  }
  const file = await createStarter(resolve(args.config), {
    instructions: "",
    name: starter.name,
    template: starter.id,
  });
  print(`Created ${file}`);
}

/** Reads only: an empty state root stays empty. */
async function showStatus(
  args: Args,
  { workspace }: OpenedWorkspace
): Promise<void> {
  const report = await readStatus(resolve(args.state));
  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { showStatus: renderStatus } = await import("~/status/view");
    await renderStatus({ here: workspace.id, report });
    return;
  }
  print(statusText(report, workspace.id));
}

function resourceContext(
  args: Flags,
  { workspace }: OpenedWorkspace
): ResourceCommandContext {
  return {
    artifacts: resolve(args.artifacts),
    directory: args.directory,
    print,
    state: resolve(args.state),
    workspace,
  };
}

/** A listing of one kind, through this workspace's view or, with `--all`, every workspace's. */
function listing<
  C extends "artifacts" | "modules" | "runs" | "sandboxes" | "sessions",
>(kind: ResourceKind): Handler<ArgsOf<C>> {
  return {
    needs: "workspace",
    run: (args, opened) =>
      listResources(kind, args.all, resourceContext(args, opened)),
  };
}

function association<C extends "share" | "unshare">(
  change: C
): Handler<ArgsOf<C>> {
  return {
    needs: "workspace",
    run: (args, opened) =>
      changeAssociation(change, args, resourceContext(args, opened)),
  };
}

async function listTriggers(
  _args: Args,
  _opened: OpenedWorkspace,
  triggers: Triggers
): Promise<void> {
  const { automations, registry } = triggers;
  const created = new Map(
    (await automations.list()).map((record) => [record.id, record.source])
  );
  /** What a monitor schedule watches: declared in the config, or by an agent. */
  const watched = (key: string): MonitorSpec | undefined =>
    registry.monitors.get(key)?.source ?? created.get(key);
  for (const entry of registry.entries()) {
    print(`[${entry.kind}] ${entry.name}`);
  }
  for (const schedule of await automations.schedules()) {
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
    // A refusal is the person's to act on: one line, with its stable code.
    // Anything else they can act on is one line too (`actionable`).
    if (!(error instanceof TaskError)) {
      throw error;
    }
    diagnose(`marbles: ${error.message} (${error.code})`);
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
async function runDaemon(): Promise<void> {
  const daemon = await startDaemon({
    layout: layout(),
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
  await attachToProcess(args, (hosted) => {
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
  const { workspace } = opened;
  const where = `${workspace.root} (${workspace.id})`;
  const forget = async (): Promise<void> => {
    // By id, in one statement: a linked workspace's record is cleared too,
    // and a Marbles process attaching it meanwhile writes after or before.
    await writeDatabase(stateDatabase(args.state), (database) =>
      new WorkspaceRegistry({ database, state: args.state }).unhost(
        workspace.id
      )
    );
  };
  const client = await joinProcess();
  if (client === undefined) {
    await forget();
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
      await forget();
      print(`${where} is not hosted`);
    }
  } finally {
    client.close();
  }
}

/** Stop the Marbles process, whatever version it runs, and return once it has exited. */
async function stopDaemon(): Promise<void> {
  const stopped = await stopProcess({
    layout: layout(),
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

/**
 * The STDIO MCP server, in two processes (`mcp/relay.ts`): this one relays
 * for the client, unless it is the server a relay started.
 */
async function serveMcp(args: ArgsOf<"mcp">): Promise<void> {
  const { isServer, relay } = await import("~/mcp/relay");
  if (!isServer()) {
    await relay(fileURLToPath(import.meta.url), process.argv.slice(2));
    return;
  }
  const { serveStdio } = await import("~/mcp/stdio");
  await serveStdio(args);
}

const COMMANDS: { readonly [C in Command]: Handler<ArgsOf<C>> } = {
  artifacts: listing("artifact"),
  attach: { needs: "nothing", run: attachWorkspace },
  daemon: { needs: "nothing", run: runDaemon },
  detach: { needs: "workspace", run: detachWorkspace },
  help: { needs: "nothing", run: () => print(USAGE) },
  init: { needs: "nothing", run: createStarterModule },
  list: { needs: "triggers", run: listTriggers },
  mcp: { needs: "nothing", run: serveMcp },
  modules: listing("module"),
  relink: {
    needs: "workspace",
    run: (args, opened) => relink(args.all, resourceContext(args, opened)),
  },
  roll: { needs: "connection", run: roll },
  run: { needs: "connection", run: runUntilStopped },
  runs: listing("run"),
  sandboxes: listing("sandbox"),
  sessions: listing("session"),
  share: association("share"),
  status: { needs: "workspace", run: showStatus },
  stop: { needs: "nothing", run: stopDaemon },
  tasks: { needs: "tasks", run: runTasks },
  unshare: association("unshare"),
  watch: { needs: "nothing", run: watch },
};

async function printNewRuns(engine: Engine, restored: ReadonlySet<string>) {
  for (const record of await engine.runs()) {
    if (!restored.has(record.id)) {
      print(`[run] ${record.step} ${record.status} ${record.id}`);
    }
  }
}

async function printErrors(
  automations: Triggers["automations"]
): Promise<void> {
  for (const [id, error] of Object.entries(await automations.errors())) {
    print(`[automation] ${id}: ${error}`);
  }
}

/** One-shot execution requires its environment; `run` and listing only warn. */
function envMode(args: { readonly command: Command }): "require" | "warn" {
  return args.command === "roll" ? "require" : "warn";
}

/** Host the workspace in this process, and report on it; only `--dry-run` does. */
async function withLocalHost(
  args: Flags & { readonly command: Command },
  run: (hosted: Hosted) => Promise<void>
): Promise<void> {
  const host = await hostHere(args, { env: envMode(args), print });
  const { engine } = host;
  try {
    printErrors(engine.automations);
    print(
      `[providers] ${engine.models.providers.map((provider) => provider.id).join(", ") || "none configured"}`
    );
    const restored = new Set((await engine.runs()).map((record) => record.id));
    await run({ host, kind: "local" });
    await printNewRuns(engine, restored);
  } finally {
    await host.close();
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
      await printErrors(triggers.automations);
      await handler.run(args, opened, triggers);
      return;
    }
    case "connection":
      await (args.dry ? withLocalHost : attachToProcess)(args, (hosted) =>
        handler.run(args, hosted)
      );
      return;
    case "tasks":
      await withTasks(args, findWorkspace(args), (tasks) =>
        handler.run(args, tasks)
      );
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
  const interactive = process.stdout.isTTY && process.stdin.isTTY;
  try {
    // A dry run writes nothing, so it never starts setup.
    if (
      interactive &&
      !args.dry &&
      (args.command === "run" || args.command === "roll")
    ) {
      const { workspace } = findWorkspace(args);
      await setupProviders({
        confirm: askYes,
        print,
        state: args.state,
        workspace: {
          dir: workspace.dir,
          id: workspace.id,
          root: workspace.root,
        },
      });
    }
    if (interactive && args.command === "run") {
      const { runInteractive } = await import("~/dashboard/command");
      await runInteractive(args);
      return;
    }
    await dispatch(args.command, args);
  } catch (error) {
    if (!actionable(error)) {
      throw error;
    }
    process.stderr.write(`marbles: ${error.message}\n`);
    process.exitCode = 1;
  }
}

/** What the person running the command can act on reads as one line. */
function actionable(error: unknown): error is Error {
  return (
    error instanceof UsageError ||
    error instanceof ConfigurationError ||
    error instanceof DatabaseBusyError ||
    error instanceof EnvironmentError ||
    error instanceof IncompatibleDatabaseError ||
    error instanceof LaunchInputError ||
    error instanceof LinksPlacementError ||
    error instanceof NoProcessError ||
    error instanceof NotHostedError ||
    error instanceof ProcessMismatchError ||
    error instanceof ProcessTimeoutError ||
    error instanceof ProcessHeldError ||
    error instanceof RecordsHeldError ||
    error instanceof ReentrantCallError ||
    error instanceof RemoteError ||
    error instanceof ResourceAssociationError ||
    error instanceof RunEndedError ||
    error instanceof RunOutputError ||
    error instanceof TaskStorageError ||
    error instanceof UnreadableDatabaseError
  );
}

/** A yes-or-no question on the terminal; an empty answer is yes. */
async function askYes(question: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

const refusal = envFilesLoaded();
if (refusal === undefined) {
  await main();
} else {
  process.stderr.write(`marbles: ${refusal}\n`);
  process.exitCode = 1;
}
