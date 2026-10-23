#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Args, ArgsOf, Command, Flags } from "~/args";
import { parseArgs, UsageError } from "~/args";
import type { Triggers } from "~/create";
import { layout } from "~/layout";
import { CLI_HARNESS_IDS } from "~/lib/cli-harnesses";
import type { Engine } from "~/lib/engine";
import { RunEndedError } from "~/lib/engine";
import type { MonitorSpec } from "~/lib/monitor";
import { describeMonitor } from "~/lib/monitor";
import { describeTrigger } from "~/lib/schedule";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { RunOutputError } from "~/lib/state/output";
import type { WorkspaceConnection } from "~/model/connection";
import type { MarblesClient } from "~/process/client";
import { connect, NoProcessError } from "~/process/client";
import { startDaemon } from "~/process/daemon";
import { ProcessHeldError } from "~/process/instance";
import { RemoteError } from "~/process/protocol";
import { sessionLines } from "~/sessions/list";
import { readStatus } from "~/status/model";
import { statusText } from "~/status/text";
import { watchRun } from "~/watch";
import { createStarter } from "~/workspace/create";
import { EnvironmentError } from "~/workspace/env";
import type { WorkspaceHost } from "~/workspace/host";
import { hostWorkspace, LaunchInputError } from "~/workspace/host";
import type { OpenedWorkspace } from "~/workspace/open";
import { findWorkspace, hostTriggers, openWorkspace } from "~/workspace/open";
import { resolveSource } from "~/workspace/source";
import { DEFAULT_HARNESS, STARTERS } from "~/workspace/templates";

const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};

const USAGE = `marbles — programmable workspace automation

  [run]                      open the dashboard; piped, attach this workspace and follow it
  init [starter]             create a starter module (developer | design | product)
  help, --help, -h            show this help
  roll <name> [--input json] dispatch one workflow or schedule now, then exit
  list                       workflows, then each schedule and monitor with its cadence
  status                     the Marbles process and every workspace under --state
  sessions                   sessions under --state: id, messages, updated, summary
  watch <runId>              replay output, follow it live, and exit when the run ends
  daemon                     run the Marbles process in the foreground
  stop                       stop the Marbles process and every workspace it hosts

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
model turn and git mutation; custom code still runs.`;

/**
 * What a command needs before it runs, each step a superset of the last:
 * `workspace` finds the source without executing it, `triggers` loads it
 * and reads what would run, `engine` builds and starts one.
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
    };

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
      await Promise.race([signal.done, client.closed]);
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

async function stopDaemon(args: ArgsOf<"stop">): Promise<void> {
  let client: MarblesClient;
  try {
    client = await connect({
      layout: layout({ artifacts: args.artifacts, state: args.state }),
      start: false,
    });
  } catch (error) {
    if (error instanceof NoProcessError) {
      print("no Marbles process is running");
      return;
    }
    throw error;
  }
  try {
    await client.shutdown();
    print(`stopping Marbles process pid ${String(client.hello.pid)}`);
  } finally {
    client.close();
  }
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
  daemon: { needs: "nothing", run: runDaemon },
  help: { needs: "nothing", run: () => print(USAGE) },
  init: { needs: "nothing", run: createStarterModule },
  list: { needs: "triggers", run: listTriggers },
  roll: { needs: "connection", run: roll },
  run: { needs: "connection", run: runUntilStopped },
  sessions: { needs: "workspace", run: listSessions },
  status: { needs: "workspace", run: showStatus },
  stop: { needs: "nothing", run: stopDaemon },
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
        error instanceof ProcessHeldError ||
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
