#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Args, ArgsOf, Command, Flags } from "~/args";
import { parseArgs, UsageError } from "~/args";
import type { Triggers } from "~/create";
import type { OpenedWorkspace } from "~/host";
import {
  findWorkspace,
  hostEngine,
  hostTriggers,
  openWorkspace,
  touchWorkspace,
} from "~/host";
import { install, launchdPlan, preview, uninstall } from "~/launchd";
import type { Engine } from "~/lib/engine";
import type { MonitorSpec } from "~/lib/monitor";
import { describeMonitor } from "~/lib/monitor";
import { describeTrigger, tick } from "~/lib/schedule";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { createStarter } from "~/onboarding/create";
import { DEFAULT_HARNESS, STARTERS } from "~/onboarding/templates";
import { runSchedulesUntilStopped } from "~/run-loop";
import { sessionLines } from "~/sessions/list";
import { readStatus } from "~/status/model";
import { statusText } from "~/status/text";

const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};

const USAGE = `marbles — programmable workspace automation

  [run]                      open the dashboard and start triggers after Enter
  init [starter]             create a starter module (developer | design | product)
  help, --help, -h            show this help
  roll <name> [--input json] dispatch one workflow or schedule now, then exit
  list                       workflows, schedules, and when each is next due
  status                     every workspace under --state: loop, schedules, runs
  sessions                   sessions under --state: id, messages, updated, summary
  launchd install <name>     write and load ~/Library/LaunchAgents/com.foundry.marbles.<name>.plist
  launchd uninstall <name>   unload and remove it

  --source <path>    authoring folder or module (default: ./.foundry/marbles)
  --config <path>    compatibility alias for --source
  --state <dir>      state root (default: ~/.foundry/marbles)
  --artifacts <dir>  artifact store holding the feed (default: artifacts/ beside the state root)
  --dry-run          echo every model turn and git mutation instead of running them
  --harness <id>     use only this harness (claude-code | codex); repeatable

Each workspace (the project above .foundry/marbles) gets <state>/<id>/ holding
workspace.json, runs/, schedules/, locks/ and sessions/. Feed entries from every
workspace share the artifact store. --dry-run disables Marbles state persistence; custom code still runs.
Under --dry-run, launchd prints the plist and launchctl commands instead of running them.`;

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
      readonly needs: "engine";
      run(args: A, engine: Engine, opened: OpenedWorkspace): Promise<void>;
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

function manageLaunchd(
  args: ArgsOf<"launchd">,
  { configPath }: OpenedWorkspace,
  { automations }: Triggers
): void {
  const { action, schedule: key } = args;
  if (process.platform !== "darwin") {
    throw new Error("launchd is macOS only");
  }
  const schedule = automations.schedules().find((record) => record.key === key);
  if (!schedule) {
    throw new Error(`no schedule named "${key}"`);
  }
  const plan = launchdPlan(schedule, {
    artifacts: resolve(args.artifacts),
    config: configPath,
    cwd: process.cwd(),
    home: homedir(),
    only: args.only,
    path: process.env.PATH ?? "",
    state: resolve(args.state),
  });
  if (args.dry) {
    preview(action, plan, print);
  } else if (action === "install") {
    install(plan, print);
  } else {
    uninstall(plan, print);
  }
}

async function roll(args: ArgsOf<"roll">, engine: Engine): Promise<void> {
  const { name } = args;
  const schedule = engine.schedules().find((record) => record.key === name);
  const input: unknown =
    args.inputJson === undefined ? schedule?.input : JSON.parse(args.inputJson);
  if (schedule) {
    const result = await tick(engine, { ...schedule, input }, { print });
    if (result) {
      print(JSON.stringify(result.value, null, 2));
    }
    return;
  }
  if (engine.definitions().some((entry) => entry.name === name)) {
    print(JSON.stringify(await engine.run<unknown>(name, input), null, 2));
    return;
  }
  throw new Error(`no workflow or schedule named "${name}"`);
}

async function runUntilStopped(
  _args: Args,
  engine: Engine,
  { config }: OpenedWorkspace
): Promise<void> {
  await runSchedulesUntilStopped(engine, { config, print });
}

const COMMANDS: { readonly [C in Command]: Handler<ArgsOf<C>> } = {
  help: { needs: "nothing", run: () => print(USAGE) },
  init: { needs: "nothing", run: createStarterModule },
  launchd: { needs: "triggers", run: manageLaunchd },
  list: { needs: "triggers", run: listTriggers },
  roll: { needs: "engine", run: roll },
  run: { needs: "engine", run: runUntilStopped },
  sessions: { needs: "workspace", run: listSessions },
  status: { needs: "workspace", run: showStatus },
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

async function withEngine(
  args: Flags,
  run: (engine: Engine, opened: OpenedWorkspace) => Promise<void>
): Promise<void> {
  const opened = await openWorkspace(args, { print });
  const engine = hostEngine(args, opened, { print });
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
      const opened = await openWorkspace(args, { print });
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
  await dispatch(args.command, args);
}

await main();
