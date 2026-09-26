#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plugin } from "bun";

import type { Args } from "~/args";
import { parseArgs } from "~/args";
import { startEngine } from "~/engine";
import { openFeed } from "~/feed/store";
import { install, launchdPlan, uninstall } from "~/launchd";
import { catalog } from "~/lib/catalog";
import { registerCatalog } from "~/lib/tree";
import type { Schedule } from "~/lib/triggers";
import { describeMonitor } from "~/monitor";
import { runSchedulesUntilStopped } from "~/run-loop";
import { bindRuntime } from "~/runtime";
import { cadence, clock, tick, weekdays } from "~/schedule";
import { JsonSessionStore } from "~/sessions/json-store";
import { sessionLines } from "~/sessions/list";
import { workspaceState } from "~/state/workspace";
import { readStatus } from "~/status/model";
import { statusText } from "~/status/text";

const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};

const USAGE = `quirks — programmable local behaviors

  [run]                      open the dashboard and start triggers after Enter
  help, --help, -h            show this help
  once <name> [--input json] dispatch one workflow or schedule now, then exit
  list                       workflows, schedules, and when each is next due
  status                     every workspace under --state: loop, schedules, runs
  sessions                   sessions under --state: id, messages, updated, summary
  launchd install <name>     write and load ~/Library/LaunchAgents/com.foundry.quirks.<name>.plist
  launchd uninstall <name>   unload and remove it

  --config <path>    config module (default: ./quirks.config.ts, optional)
  --state <dir>      state root (default: ~/.foundry/quirks)
  --artifacts <dir>  artifact store holding the feed (default: artifacts/ beside the state root)
  --dry              echo every model turn and git mutation instead of running them
  --harness <id>     use only this harness (claude-code | codex); repeatable

Each workspace (the config's directory) gets <state>/<id>/ holding
workspace.json, runs/, schedules/, locks/ and sessions/. Feed entries from every
workspace share the artifact store. --dry disables Quirks state persistence; custom code still runs.`;

type Engine = Awaited<ReturnType<typeof startEngine>>;
type WorkspaceState = ReturnType<typeof workspaceState>;

async function loadConfiguration(
  configPath: string,
  log = print
): Promise<boolean> {
  if (!existsSync(configPath)) {
    return false;
  }

  // Configs use this installation even outside a project with node_modules.
  // Both entry points must share the same registry instance.
  const libraryPath = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./lib/index.ts" : "./index.js",
      import.meta.url
    )
  );
  const library = await import(libraryPath);
  const prebuilt = await import(
    new URL(
      import.meta.url.endsWith(".ts") ? "./prebuilt.ts" : "./prebuilt.js",
      import.meta.url
    ).href
  );
  plugin({
    name: "quirks-config-library",
    setup(builder) {
      builder.module("@foundry/quirks/prebuilt", () => ({
        exports: prebuilt,
        loader: "object",
      }));
      builder.module("@foundry/quirks", () => ({
        exports: library,
        loader: "object",
      }));
    },
    target: "bun",
  });
  await import(pathToFileURL(configPath).href);
  log(`[config] ${configPath}`);
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
      print(`[monitor] ${schedule.key} ${describeMonitor(monitor)} ${when}`);
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
  const schedule = catalog.schedules.get(target);
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
    manageLaunchd(args.name, args.target, configPath, args.state);
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
  const schedule = catalog.schedules.get(name);
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
  if (catalog.definitions.has(name)) {
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
  configPath: string
): Promise<boolean> {
  if (args.command === "once" && args.name) {
    await runOnce(engine, args.name, args.inputJson, stateDir);
    return true;
  }
  if (args.command === "run") {
    await runSchedulesUntilStopped(
      engine,
      schedules,
      stateDir,
      hasConfig,
      configPath
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

  if (args.command === "run" && process.stdout.isTTY && process.stdin.isTTY) {
    const { runInteractive } = await import("~/dashboard/command");
    await runInteractive(args, loadConfiguration);
    return;
  }

  const configPath = resolve(args.config);
  const hasConfig = await loadConfiguration(configPath);
  const workspace = workspaceState(
    resolve(args.state),
    hasConfig ? dirname(configPath) : process.cwd()
  );
  // The one place --dry is applied to the state dir: everything downstream
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

  const schedules = [...catalog.schedules.values()];
  if (await handleNonRuntimeCommand(args, workspace, schedules, configPath)) {
    return;
  }

  const feed = openFeed(
    args.dry ? undefined : resolve(args.artifacts),
    workspace
  );
  const runtime = bindRuntime({
    artifacts: feed.artifacts,
    dry: args.dry,
    only: args.only,
    print,
    root: workspace.root,
    state: stateDir,
    workspaceId: workspace.id,
  });
  print(`[harnesses] ${runtime.harnesses.join(", ")}`);

  const engine = await startEngine(registerCatalog, {
    feed: feed.publisher,
    print,
    state: stateDir,
  });
  const restored = new Set((await engine.runs()).map((record) => record.id));

  try {
    const executed = await dispatchRuntimeCommand(
      args,
      engine,
      schedules,
      stateDir,
      hasConfig,
      configPath
    );
    if (executed) {
      await printNewRuns(engine, restored);
    }
  } finally {
    await engine.stop();
    await runtime.dispose();
  }
}

await main();
