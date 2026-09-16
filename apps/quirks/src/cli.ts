#!/usr/bin/env bun
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs } from "~/args";
import { startEngine } from "~/engine";
import { install, launchdPlan, uninstall } from "~/launchd";
import { registry } from "~/lib/registry";
import { runLive } from "~/live";
import { describeMonitor } from "~/monitor";
import { bindRuntime } from "~/runtime";
import { cadence, clock, runSchedules, tick, weekdays } from "~/schedule";
import { JsonSessionStore } from "~/sessions/json-store";
import { sessionLines } from "~/sessions/list";
import { writeJson } from "~/state/json";
import { workspaceState } from "~/state/workspace";
import { readStatus } from "~/status/model";
import { statusText } from "~/status/text";

import "~/builtins";

const print = (line: string) => {
  process.stdout.write(`${line}\n`);
};

const USAGE = `quirks — agent workflow runner

  run                        run every configured schedule until stopped
  once <name> [--input json] dispatch one workflow or schedule now, then exit
  list                       workflows, schedules, and when each is next due
  status                     every workspace under --state: loop, schedules, runs
  sessions                   sessions under --state: id, messages, updated, summary
  launchd install <name>     write and load ~/Library/LaunchAgents/com.foundry.quirks.<name>.plist
  launchd uninstall <name>   unload and remove it

  --config <path>    config module (default: ./quirks.config.ts, optional)
  --state <dir>      state root (default: ~/.foundry/quirks)
  --dry              echo every model turn and git mutation instead of running them
  --harness <id>     use only this harness (claude-code | codex); repeatable

Each workspace (the config's directory) gets <state>/<id>/ holding
workspace.json, runs/, schedules/, locks/ and sessions/. --dry writes nothing.`;

async function main(): Promise<void> {
  const { command, name, target, dry, config, state, inputJson, only } =
    parseArgs(process.argv.slice(2));
  if (!command) {
    print(USAGE);
    return;
  }

  const configPath = resolve(config);
  const hasConfig = existsSync(configPath);
  if (hasConfig) {
    await import(pathToFileURL(configPath).href);
    print(`[config] ${configPath}`);
  }

  const workspace = workspaceState(
    resolve(state),
    hasConfig ? dirname(configPath) : process.cwd()
  );
  // The one place --dry is applied to the state dir: everything downstream
  // takes `stateDir` and writes nothing when it is undefined.
  const stateDir = dry ? undefined : workspace.dir;

  // Reads files only, so it runs before this workspace is touched or the
  // engine is built: an empty state root stays empty.
  if (command === "status") {
    const report = readStatus(resolve(state));
    if (process.stdout.isTTY && process.stdin.isTTY) {
      const { showStatus } = await import("~/status/view");
      await showStatus({ here: workspace.id, report });
    } else {
      print(statusText(report, workspace.id));
    }
    return;
  }

  if (stateDir !== undefined) {
    workspace.touch(hasConfig ? configPath : null);
  }

  const schedules = [...registry.schedules.values()];

  if (command === "list") {
    const { monitors } = registry;
    for (const key of registry.definitions.keys()) {
      if (!monitors.has(key)) {
        print(`[workflow] ${key}`);
      }
    }
    for (const schedule of schedules) {
      const { trigger } = schedule;
      const when =
        trigger.kind === "interval"
          ? `every ${cadence(trigger.ms)}`
          : `at ${weekdays(trigger.slot).join(",") || "daily"} ${clock(trigger.slot)}`;
      const monitor = monitors.get(schedule.name);
      if (monitor?.kind === "ws") {
        print(`[monitor] ${schedule.name} ${describeMonitor(monitor)}`);
      } else if (monitor) {
        print(`[monitor] ${schedule.name} ${describeMonitor(monitor)} ${when}`);
      } else {
        print(`[schedule] ${schedule.name} → ${schedule.workflow} ${when}`);
      }
    }
    return;
  }

  if (command === "sessions") {
    const dir = join(workspace.dir, "sessions");
    // The store mkdirs on construction; a listing must not leave one behind.
    if (existsSync(dir)) {
      for (const line of await sessionLines(new JsonSessionStore(dir))) {
        print(line);
      }
    }
    return;
  }

  if (command === "launchd") {
    if (name !== "install" && name !== "uninstall") {
      throw new Error("quirks: launchd takes install or uninstall");
    }
    if (target === undefined) {
      throw new Error("quirks: launchd needs a schedule");
    }
    if (process.platform !== "darwin") {
      throw new Error("quirks: launchd is macOS only");
    }
    const schedule = registry.schedules.get(target);
    if (!schedule) {
      throw new Error(`quirks: no schedule named "${target}"`);
    }
    if (registry.monitors.get(target)?.kind === "ws") {
      throw new Error(
        `quirks: "${target}" is a ws monitor, which is live-only; use \`quirks run\``
      );
    }
    const plan = launchdPlan(schedule, {
      config: configPath,
      cwd: process.cwd(),
      home: homedir(),
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- the OS PATH launchd will not inherit, not app config
      path: process.env.PATH ?? "",
      state: resolve(state),
    });
    if (name === "install") {
      install(plan, print);
    } else {
      uninstall(plan, print);
    }
    return;
  }

  const runtime = bindRuntime({
    dry,
    only,
    print,
    root: workspace.root,
    state: stateDir,
  });
  print(
    `[harnesses] ${runtime.primitives.executors.map((e) => e.harness).join(", ")}`
  );

  const engine = await startEngine(
    (orchestrator) => {
      for (const register of registry.definitions.values()) {
        register(orchestrator);
      }
    },
    { print, state: stateDir }
  );
  const restored = new Set((await engine.runs()).map((record) => record.id));

  try {
    if (command === "once" && name) {
      const schedule = registry.schedules.get(name);
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
      } else if (registry.definitions.has(name)) {
        print(JSON.stringify(await engine.run<unknown>(name, input), null, 2));
      } else {
        throw new Error(`quirks: no workflow or schedule named "${name}"`);
      }
    } else if (command === "run") {
      if (schedules.length === 0) {
        throw new Error(
          "quirks: nothing scheduled; add schedule(...) to config"
        );
      }
      const controller = new AbortController();
      process.once("SIGINT", () => {
        controller.abort();
      });
      const heartbeat =
        stateDir === undefined ? undefined : join(stateDir, "heartbeat.json");
      if (heartbeat !== undefined) {
        writeJson(heartbeat, {
          config: hasConfig ? configPath : null,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          version: 1,
        });
      }
      // A ws monitor has nothing to poll; files monitors keep their poll as a
      // net under the watcher.
      const live = schedules.flatMap((schedule) => {
        const spec = registry.monitors.get(schedule.name);
        return spec === undefined || spec.kind === "http"
          ? []
          : [{ schedule, spec }];
      });
      const polled = schedules.filter(
        (schedule) => registry.monitors.get(schedule.name)?.kind !== "ws"
      );
      const options = { print, signal: controller.signal, state: stateDir };
      try {
        await Promise.all([
          runLive(engine, live, { ...options, root: workspace.root }),
          runSchedules(engine, polled, options),
        ]);
      } finally {
        if (heartbeat !== undefined) {
          rmSync(heartbeat, { force: true });
        }
      }
    } else {
      print(USAGE);
      process.exitCode = 1;
      return;
    }

    for (const record of await engine.runs()) {
      if (restored.has(record.id)) {
        continue;
      }
      print(`[run] ${record.step} ${record.status} ${record.id}`);
    }
  } finally {
    await engine.stop();
    await runtime.dispose();
  }
}

await main();
