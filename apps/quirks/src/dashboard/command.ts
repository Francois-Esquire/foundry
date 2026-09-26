import { basename, dirname, resolve } from "node:path";
import type { Args } from "~/args";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { openDashboard } from "~/dashboard/terminal";
import type { Engine } from "~/engine";
import { startEngine } from "~/engine";
import { registerSetupStep, SETUP_STEP, type SetupInput } from "~/feed/setup";
import { type FeedStore, openFeed } from "~/feed/store";
import { catalog } from "~/lib/catalog";
import { inputFromFields, validate } from "~/lib/schema";
import { registerCatalog } from "~/lib/tree";
import { createConfig } from "~/onboarding/config";
import type { SetupDraft } from "~/onboarding/templates";
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
  let feed: FeedStore | undefined;
  let createdDraft: SetupDraft | undefined;
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
        createdDraft = draft;
        try {
          await loadConfiguration(configPath, print);
        } catch (error) {
          catalog.reset();
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
    feed = openFeed(args.dry ? undefined : resolve(args.artifacts), workspace);
    runtime = bindRuntime({
      artifacts: feed.artifacts,
      dry: args.dry,
      only: args.only,
      print,
      root: workspace.root,
      state,
      workspaceId: workspace.id,
    });
    engine = await startEngine(
      (orchestrator) => {
        registerCatalog(orchestrator);
        registerSetupStep(orchestrator);
      },
      { askable: true, feed: feed.publisher, print, state }
    );
    if (controller.signal.aborted) {
      return;
    }
    const schedules = [...catalog.schedules.values()];
    const lastFinish = new Map(
      schedules.flatMap((schedule) => {
        const finish =
          state === undefined ? undefined : readLastFinish(state, schedule.key);
        return finish === undefined ? [] : [[schedule.key, finish] as const];
      })
    );
    let startedAt = Date.now();
    const runningEngine = engine;
    const { harnesses } = runtime;
    const readFeed = feed.read;
    const update = async () =>
      terminal.update(
        dashboardSnapshot(await runningEngine.runs(), {
          feed: await readFeed(),
          harnesses,
          lastFinish,
          root: workspace.root,
          startedAt,
          status: args.dry ? `dry · ${status}` : status,
          workspaceId: workspace.id,
        }),
        hasConfig
      );
    terminal.setAnswerer(async (entryId, answer) => {
      await runningEngine.answer(entryId, answer);
      await update();
    });
    terminal.setRunActions({
      async cancel(runId) {
        await runningEngine.cancel(runId);
        await update();
      },
      async pause(runId, stepId) {
        if (!runningEngine.pause(runId, stepId)) {
          throw new Error("This step is not running in this process.");
        }
        await update();
      },
      async resume(runId, stepId, prompt) {
        await runningEngine.resume(runId, stepId, prompt);
        await update();
      },
      steer(runId, stepId, prompt) {
        runningEngine.steer(runId, stepId, prompt);
        return Promise.resolve();
      },
      stream: (runId, signal) => runningEngine.stream(runId, signal),
    });
    terminal.setLauncher(async (name, input) => {
      const definition = catalog.definitions.get(name);
      if (!definition || catalog.monitors.has(name)) {
        throw new Error("This definition is not available for manual launch.");
      }
      const values =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      // Validate here so the form sees the error, but launch with the raw
      // value: the factory parses once, and a transform must not run twice.
      const raw = inputFromFields(values);
      if (definition.input) {
        await validate(definition.input, raw, `"${name}" input`);
      }
      const launched = await runningEngine.launch(name, raw);
      launched.result.catch((error: unknown) =>
        print(`[run] ${String(error)}`)
      );
      await update();
      return launched.id;
    });
    postSetupMilestone(runningEngine, print, createdDraft, {
      configPath,
      root: workspace.root,
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

/** Onboarding's feed entry comes from a real Run, like every other entry. */
function postSetupMilestone(
  engine: Engine,
  print: (line: string) => void,
  draft: SetupDraft | undefined,
  context: Omit<SetupInput, "draft">
): void {
  if (!draft) {
    return;
  }
  const input: SetupInput = { ...context, draft };
  engine
    .run(SETUP_STEP, input)
    .catch((error: unknown) => print(`[feed] ${String(error)}`));
}
