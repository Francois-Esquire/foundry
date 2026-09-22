import { basename, dirname, resolve } from "node:path";
import type { Args } from "~/args";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { openDashboard } from "~/dashboard/terminal";
import type { Engine } from "~/engine";
import { startEngine } from "~/engine";
import { launchInput } from "~/lib/inputs";
import { registry } from "~/lib/registry";
import { createConfig } from "~/onboarding/config";
import { runSchedulesUntilStopped } from "~/run-loop";
import type { Runtime } from "~/runtime";
import { bindRuntime } from "~/runtime";
import { readLastFinish } from "~/state/schedules";
import { workspaceState } from "~/state/workspace";

export async function runInteractive(
  args: Args,
  loadConfiguration: (
    path: string,
    print: (line: string) => void
  ) => Promise<boolean>
): Promise<void> {
  const controller = new AbortController();
  const configPath = resolve(args.config);
  const terminal = await openDashboard(
    basename(dirname(configPath)),
    controller
  );
  let status = "Loading config";
  const print = (line: string) => {
    status = line;
  };
  let runtime: Runtime | undefined;
  let engine: Engine | undefined;
  let loop: Promise<void> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    controller.abort();
    stopping ??= engine?.stop({ cancel: true });
    // Attach immediately: cleanup below awaits and reports any failure.
    stopping?.catch(() => undefined);
  };
  controller.signal.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    let hasConfig = await loadConfiguration(configPath, print);
    if (!(hasConfig || controller.signal.aborted)) {
      hasConfig = await terminal.onboard(configPath, async (draft) => {
        await createConfig(configPath, draft);
        try {
          await loadConfiguration(configPath, print);
        } catch (error) {
          registry.reset();
          throw new Error(
            `Config was created but could not load: ${String(error)}. Fix it and restart Quirks.`,
            { cause: error }
          );
        }
      });
    }
    if (controller.signal.aborted) {
      return;
    }
    const workspace = workspaceState(
      resolve(args.state),
      hasConfig ? dirname(configPath) : process.cwd()
    );
    const state = args.dry ? undefined : workspace.dir;
    runtime = bindRuntime({
      dry: args.dry,
      only: args.only,
      print,
      root: workspace.root,
      state,
    });
    engine = await startEngine(
      (orchestrator) => {
        for (const register of registry.definitions.values()) {
          register(orchestrator);
        }
      },
      { print, state }
    );
    if (controller.signal.aborted) {
      return;
    }
    const schedules = [...registry.schedules.values()];
    const lastFinish = new Map(
      schedules.flatMap((schedule) => {
        const finish =
          state === undefined
            ? undefined
            : readLastFinish(state, schedule.name);
        return finish === undefined ? [] : [[schedule.name, finish] as const];
      })
    );
    let startedAt = Date.now();
    const runningEngine = engine;
    const harnesses = runtime.primitives.executors.map(
      (executor) => executor.harness
    );
    const update = async () =>
      terminal.update(
        dashboardSnapshot(await runningEngine.runs(), {
          harnesses,
          lastFinish,
          root: workspace.root,
          startedAt,
          status: args.dry ? `dry · ${status}` : status,
        }),
        hasConfig
      );
    terminal.setLauncher(async (name, input) => {
      if (!registry.definitions.has(name) || registry.monitors.has(name)) {
        throw new Error("This definition is not available for manual launch.");
      }
      const launched = await runningEngine.launch(
        name,
        launchInput(registry.definitionOptions.get(name), input)
      );
      launched.result.catch((error: unknown) =>
        print(`[run] ${String(error)}`)
      );
      await update();
      return launched.id;
    });
    status = hasConfig
      ? "Config loaded"
      : "No config found · add quirks.config.ts to register triggers";
    await update();
    if (!(await terminal.entry)) {
      return;
    }
    startedAt = Date.now();
    if (state !== undefined) {
      workspace.touch(hasConfig ? configPath : null);
    }
    status =
      schedules.length === 0
        ? "Ready · no triggers configured"
        : "Watching triggers";
    await update();
    // Engine reads are local; serialize refreshes so older snapshots cannot replace newer ones.
    let updating = false;
    refresh = setInterval(() => {
      if (updating || controller.signal.aborted) {
        return;
      }
      updating = true;
      update()
        .catch((error: unknown) => {
          print(`[dashboard] ${String(error)}`);
        })
        .finally(() => {
          updating = false;
        });
    }, 200);
    loop = runSchedulesUntilStopped(
      engine,
      schedules,
      workspace,
      state,
      hasConfig,
      configPath,
      controller,
      print
    );
    await loop;
  } catch (error) {
    process.exitCode = 1;
    if (!controller.signal.aborted) {
      await terminal.failure(error);
    }
  } finally {
    if (refresh !== undefined) {
      clearInterval(refresh);
    }
    stop();
    try {
      await stopping;
      await loop;
    } finally {
      try {
        await runtime?.dispose();
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        controller.signal.removeEventListener("abort", stop);
        terminal.close();
      }
    }
  }
}
