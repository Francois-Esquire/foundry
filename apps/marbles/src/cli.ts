#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Tasks } from "@foundry/tasks";
import { TaskError } from "@foundry/tasks";
import type { Args, ArgsOf, Command, Flags } from "~/args";
import { parseArgs, UsageError } from "~/args";
import type { Triggers } from "~/create";
import type { OpenedWorkspace } from "~/host";
import {
  findWorkspace,
  hostEngine,
  hostTasks,
  hostTriggers,
  openWorkspace,
  touchWorkspace,
  workspaceEngine,
} from "~/host";
import { CLI_HARNESS_IDS } from "~/lib/cli-harnesses";
import type { Engine } from "~/lib/engine";
import { RunEndedError } from "~/lib/engine";
import { RecordsHeldError } from "~/lib/events/records";
import type { MonitorSpec } from "~/lib/monitor";
import { describeMonitor } from "~/lib/monitor";
import { describeTrigger, tick } from "~/lib/schedule";
import { SchemaError } from "~/lib/schema";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { RunOutputError } from "~/lib/state/output";
import { createStarter } from "~/onboarding/create";
import { DEFAULT_HARNESS, STARTERS } from "~/onboarding/templates";
import { runSchedulesUntilStopped } from "~/run-loop";
import { sessionLines } from "~/sessions/list";
import { readStatus } from "~/status/model";
import { statusText } from "~/status/text";
import { runTaskCommand } from "~/tasks/command";
import { taskCommandText } from "~/tasks/text";
import { watchRun } from "~/watch";

const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};
/** Diagnostics where a command's own output is data, such as `--json`. */
const diagnose = (line: string) => {
  process.stderr.write(`${line}\n`);
};

const USAGE = `marbles — programmable workspace automation

  [run]                      open the dashboard and start triggers after Enter
  init [starter]             create a starter module (developer | design | product)
  help, --help, -h            show this help
  roll <name> [--input json] dispatch one workflow or schedule now, then exit
  list                       workflows, then each schedule and monitor with its cadence
  status                     every workspace under --state: loop, schedules, runs
  sessions                   sessions under --state: id, messages, updated, summary
  tasks <action> [--json]    read or change this workspace's tasks (below)
  watch <runId>              replay output, follow it live, and exit when the run ends

  --source <path>    authoring folder or module (default: ./.foundry/marbles)
  --config <path>    compatibility alias for --source
  --state <dir>      state root (default: ~/.foundry/marbles)
  --artifacts <dir>  artifact store holding the feed (default: artifacts/ beside the state root)
  --dry-run          echo every model turn and git mutation instead of running them
  --harness <id>     use only this harness (${CLI_HARNESS_IDS.join(" | ")}); repeatable

Each workspace (the project above .foundry/marbles) gets <state>/<id>/ holding
workspace.json, runs/, output/, schedules/, locks/ and sessions/. Feed entries from every
workspace share the artifact store. --dry-run disables Marbles state persistence; custom code still runs.

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
Tasks are kept with the workspace state (memory only under --dry-run); no source runs.`;

/**
 * What a command needs before it runs, each step a superset of the last:
 * `workspace` finds the source without executing it, `triggers` loads it
 * and reads what would run, `engine` builds and starts one. `tasks` is
 * beside them: the found workspace's tasks, through an engine that is never
 * started, so no source runs and nothing is delivered here.
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
      readonly needs: "engine";
      run(args: A, engine: Engine, opened: OpenedWorkspace): Promise<void>;
    }
  | { readonly needs: "tasks"; run(args: A, tasks: Tasks): Promise<void> };

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

async function roll(args: ArgsOf<"roll">, engine: Engine): Promise<void> {
  const { name } = args;
  const schedule = engine.schedules().find((record) => record.key === name);
  const input: unknown =
    args.inputJson === undefined ? schedule?.input : inputFrom(args.inputJson);
  if (schedule) {
    const result = await tick(engine, { ...schedule, input }, { print });
    if (result) {
      print(JSON.stringify(result.value, null, 2));
    }
    return;
  }
  if (engine.definitions().some((entry) => entry.name === name)) {
    const output = await engine.run<unknown>(name, input).catch((error) => {
      throw error instanceof SchemaError
        ? new UsageError(inputHint(engine, name, error))
        : error;
    });
    print(JSON.stringify(output, null, 2));
    return;
  }
  throw new Error(`no workflow or schedule named "${name}"`);
}

async function runTasks(args: ArgsOf<"tasks">, tasks: Tasks): Promise<void> {
  let result: Awaited<ReturnType<typeof runTaskCommand>>;
  try {
    result = await runTaskCommand(tasks, args.task);
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

async function runUntilStopped(
  _args: Args,
  engine: Engine,
  { config }: OpenedWorkspace
): Promise<void> {
  await runSchedulesUntilStopped(engine, { config, print });
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
  help: { needs: "nothing", run: () => print(USAGE) },
  init: { needs: "nothing", run: createStarterModule },
  list: { needs: "triggers", run: listTriggers },
  roll: { needs: "engine", run: roll },
  run: { needs: "engine", run: runUntilStopped },
  sessions: { needs: "workspace", run: listSessions },
  status: { needs: "workspace", run: showStatus },
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

async function withEngine(
  args: Flags & { readonly command: Command },
  run: (engine: Engine, opened: OpenedWorkspace) => Promise<void>
): Promise<void> {
  const opened = await openWorkspace(args, { env: envMode(args), print });
  const engine = await hostEngine(args, opened, { print });
  touchWorkspace(engine, opened);
  printErrors(engine.automations);
  print(`[harnesses] ${engine.harnesses.join(", ")}`);
  try {
    await engine.start();
    const restored = new Set((await engine.runs()).map((record) => record.id));
    await run(engine, opened);
    await printNewRuns(engine, restored);
  } finally {
    await engine.stop();
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
    case "engine":
      await withEngine(args, (engine, opened) =>
        handler.run(args, engine, opened)
      );
      return;
    case "tasks": {
      const engine = workspaceEngine(args, findWorkspace(args), {
        print: diagnose,
      });
      try {
        await handler.run(args, hostTasks(engine));
      } finally {
        // Gives up the workspace's tasks for the next process.
        await engine.dispose();
      }
      return;
    }
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
