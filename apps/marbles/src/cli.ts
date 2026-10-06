#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plugin } from "bun";
import type { Args } from "~/args";
import { parseArgs } from "~/args";
import { catalog } from "~/authoring/catalog";
import { createEngine, readTriggers } from "~/create";
import { install, launchdPlan, uninstall } from "~/launchd";
import type { Engine } from "~/lib/engine";
import { describeMonitor } from "~/lib/monitor";
import { cadence, clock, tick, weekdays } from "~/lib/schedule";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { workspaceState } from "~/lib/state/workspace";
import type { Schedule } from "~/lib/triggers";
import { createStarter } from "~/onboarding/create";
import { STARTERS } from "~/onboarding/templates";
import { runSchedulesUntilStopped } from "~/run-loop";
import { sessionLines } from "~/sessions/list";
import { resolveSource, sourceFiles, sourceRoot } from "~/source";
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
workspace share the artifact store. --dry-run disables Marbles state persistence; custom code still runs.`;

type WorkspaceState = ReturnType<typeof workspaceState>;

async function loadSource(configPath: string, log = print): Promise<boolean> {
  const files = sourceFiles(configPath);
  if (files === undefined) {
    return false;
  }

  // Authoring modules use this installation even outside a project with node_modules.
  // Both entry points must share the same registry instance.
  const libraryPath = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./authoring/index.ts" : "./index.js",
      import.meta.url
    )
  );
  const library = await import(libraryPath);
  const prebuilt = await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./authoring/prebuilt.ts"
        : "./prebuilt.js",
      import.meta.url
    ).href
  );
  plugin({
    name: "marbles-source-library",
    setup(builder) {
      builder.module("@foundry/marbles/prebuilt", () => ({
        exports: prebuilt,
        loader: "object",
      }));
      builder.module("@foundry/marbles", () => ({
        exports: library,
        loader: "object",
      }));
    },
    target: "bun",
  });
  for (const file of files) {
    await import(pathToFileURL(file).href);
  }
  log(`[source] ${configPath}`);
  return true;
}

async function showStatus(
  workspace: WorkspaceState,
  state: string
): Promise<void> {
  const report = readStatus(resolve(state));
  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { showStatus: renderStatus } = await import("~/status/view");
    await renderStatus({ here: workspace.id, report });
    return;
  }
  print(statusText(report, workspace.id));
}

function listRegistry(schedules: readonly Schedule[]): void {
  const { monitors } = catalog;
  for (const entry of catalog.entries()) {
    print(`[${entry.kind}] ${entry.name}`);
  }
  for (const schedule of schedules) {
    const { trigger } = schedule;
    const when =
      trigger.kind === "interval"
        ? `every ${cadence(trigger.ms)}`
        : `at ${weekdays(trigger.slot).join(",") || "daily"} ${clock(trigger.slot)}`;
    const monitor = monitors.get(schedule.key);
    if (monitor) {
      print(
        `[monitor] ${schedule.key} ${describeMonitor(monitor.source)} ${when}`
      );
    } else {
      const input =
        schedule.input === null ? "" : ` ${JSON.stringify(schedule.input)}`;
      print(
        `[schedule] ${schedule.key} → ${schedule.workflow}${input} ${when}`
      );
    }
  }
}

async function listSessions(workspace: WorkspaceState): Promise<void> {
  const dir = join(workspace.dir, "sessions");
  // The store mkdirs on construction; a listing must not leave one behind.
  if (!existsSync(dir)) {
    return;
  }
  for (const line of await sessionLines(new JsonSessionStore(dir))) {
    print(line);
  }
}

function manageLaunchd(
  name: string | undefined,
  target: string | undefined,
  schedules: readonly Schedule[],
  configPath: string,
  state: string
): void {
  if (name !== "install" && name !== "uninstall") {
    throw new Error("launchd takes install or uninstall");
  }
  if (target === undefined) {
    throw new Error("launchd needs a schedule");
  }
  if (process.platform !== "darwin") {
    throw new Error("launchd is macOS only");
  }
  const schedule = schedules.find((record) => record.key === target);
  if (!schedule) {
    throw new Error(`no schedule named "${target}"`);
  }
  const plan = launchdPlan(schedule, {
    config: configPath,
    cwd: process.cwd(),
    home: homedir(),
    path: process.env.PATH ?? "",
    state: resolve(state),
  });
  if (name === "install") {
    install(plan, print);
  } else {
    uninstall(plan, print);
  }
}

async function handleNonRuntimeCommand(
  args: Args,
  workspace: WorkspaceState,
  schedules: readonly Schedule[],
  configPath: string
): Promise<boolean> {
  if (args.command === "list") {
    listRegistry(schedules);
    return true;
  }
  if (args.command === "sessions") {
    await listSessions(workspace);
    return true;
  }
  if (args.command === "launchd") {
    manageLaunchd(args.name, args.target, schedules, configPath, args.state);
    return true;
  }
  return false;
}

async function runOnce(
  engine: Engine,
  name: string,
  inputJson: string | undefined,
  stateDir: string | undefined
): Promise<void> {
  const schedule = engine.schedules().find((record) => record.key === name);
  const input: unknown =
    inputJson === undefined ? schedule?.input : JSON.parse(inputJson);
  if (schedule) {
    const result = await tick(
      engine,
      { ...schedule, input },
      { print, state: stateDir }
    );
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

async function dispatchRuntimeCommand(
  args: Args,
  engine: Engine,
  schedules: readonly Schedule[],
  stateDir: string | undefined,
  hasConfig: boolean,
  configPath: string,
  getSchedules: () => readonly Schedule[]
): Promise<boolean> {
  if (args.command === "roll" && args.name) {
    await runOnce(engine, args.name, args.inputJson, stateDir);
    return true;
  }
  if (args.command === "run") {
    await runSchedulesUntilStopped(
      engine,
      schedules,
      stateDir,
      hasConfig,
      configPath,
      undefined,
      print,
      getSchedules
    );
    return true;
  }
  print(USAGE);
  process.exitCode = 1;
  return false;
}

async function printNewRuns(engine: Engine, restored: ReadonlySet<string>) {
  for (const record of await engine.runs()) {
    if (!restored.has(record.id)) {
      print(`[run] ${record.step} ${record.status} ${record.id}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    print(USAGE);
    return;
  }

  if (args.command === "init") {
    const starter = STARTERS.find(
      (item) => item.id === (args.name ?? "product")
    );
    if (!starter || args.target !== undefined) {
      throw new Error("init takes one starter: developer, design, or product");
    }
    const file = await createStarter(resolve(args.config), {
      harness: "auto",
      instructions: "",
      name: starter.name,
      template: starter.id,
    });
    print(`Created ${file}`);
    return;
  }

  // `run` starts every trigger and takes no name; a name here would
  // otherwise be dropped and the dashboard opened instead.
  if (args.command === "run" && args.name !== undefined) {
    print(`run takes no name. To run one now: marbles roll ${args.name}`);
    process.exitCode = 1;
    return;
  }

  if (args.command === "run" && process.stdout.isTTY && process.stdin.isTTY) {
    const { runInteractive } = await import("~/dashboard/command");
    await runInteractive(args, loadSource);
    return;
  }

  const configPath = resolveSource(args.config);
  const hasConfig = await loadSource(configPath);
  const workspace = workspaceState(
    resolve(args.state),
    hasConfig ? sourceRoot(configPath) : process.cwd()
  );
  // The one place --dry-run is applied to the state dir: everything downstream
  // takes `stateDir` and writes nothing when it is undefined.
  const stateDir = args.dry ? undefined : workspace.dir;

  // Reads files only, so it runs before this workspace is touched or the
  // engine is built: an empty state root stays empty.
  if (args.command === "status") {
    await showStatus(workspace, args.state);
    return;
  }

  if (stateDir !== undefined) {
    workspace.touch(hasConfig ? configPath : null);
  }

  // Listing reads the triggers from disk; only a command that runs
  // something builds the engine.
  const triggers = readTriggers(catalog, stateDir);
  const schedules = triggers.schedules();
  for (const [file, error] of Object.entries(triggers.errors())) {
    print(`[automation] ${file}: ${error}`);
  }
  if (await handleNonRuntimeCommand(args, workspace, schedules, configPath)) {
    return;
  }

  const engine = createEngine({
    artifacts: resolve(args.artifacts),
    catalog,
    dry: args.dry,
    only: args.only,
    print,
    root: workspace.root,
    state: stateDir,
    workspaceId: workspace.id,
  });
  print(`[harnesses] ${engine.harnesses.join(", ")}`);

  try {
    await engine.start();
    const restored = new Set((await engine.runs()).map((record) => record.id));
    const executed = await dispatchRuntimeCommand(
      args,
      engine,
      schedules,
      stateDir,
      hasConfig,
      configPath,
      () => engine.schedules()
    );
    if (executed) {
      await printNewRuns(engine, restored);
    }
  } finally {
    await engine.stop();
    await engine.dispose();
  }
}

await main();
