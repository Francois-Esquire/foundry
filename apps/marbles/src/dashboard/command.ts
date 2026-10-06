import { basename, resolve } from "node:path";
import type { Args } from "~/args";
import { catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { openDashboard } from "~/dashboard/terminal";
import type { Engine } from "~/lib/engine";
import { inputFromFields } from "~/lib/schema";
import { readLastFinish } from "~/lib/state/schedules";
import { workspaceState } from "~/lib/state/workspace";
import { createStarter } from "~/onboarding/create";
import {
  registerSetupStep,
  SETUP_STEP,
  type SetupInput,
} from "~/onboarding/setup-step";
import type { SetupDraft } from "~/onboarding/templates";
import { runSchedulesUntilStopped } from "~/run-loop";
import { resolveSource, sourceRoot } from "~/source";

export async function runInteractive(
  args: Args,
  loadSource: (path: string, print: (line: string) => void) => Promise<boolean>
): Promise<void> {
  const controller = new AbortController();
  const configPath = resolveSource(args.config);
  const terminal = await openDashboard(
    basename(sourceRoot(configPath)),
    controller
  );
  let status = "Loading marbles";
  const print = (line: string) => {
    status = line;
  };
  // Built before it starts: `built` is what cleanup disposes, `engine` is
  // set only once it runs, so a stop requested mid-start has nothing to stop.
  let built: Engine | undefined;
  let createdDraft: SetupDraft | undefined;
  let createdFile: string | undefined;
  let engine: Engine | undefined;
  let loop: Promise<void> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    controller.abort();
    stopping ??= stopAfterSchedules(loop, engine);
    // Attach immediately: cleanup below awaits and reports any failure.
    stopping?.catch(() => undefined);
  };
  controller.signal.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    let hasConfig = await loadSource(configPath, print);
    if (!(hasConfig || controller.signal.aborted)) {
      hasConfig = await terminal.onboard(configPath, async (draft) => {
        createdFile = await createStarter(configPath, draft);
        createdDraft = draft;
        try {
          await loadSource(configPath, print);
        } catch (error) {
          catalog.reset();
          throw new Error(
            `Starter was created but could not load: ${String(error)}. Fix it and restart Marbles.`,
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
      hasConfig ? sourceRoot(configPath) : process.cwd()
    );
    const state = args.dry ? undefined : workspace.dir;
    built = createEngine({
      artifacts: resolve(args.artifacts),
      askable: true,
      catalog,
      dry: args.dry,
      only: args.only,
      print,
      root: workspace.root,
      state,
      workspaceId: workspace.id,
    });
    registerSetupStep(built);
    engine = await built.start();
    if (controller.signal.aborted) {
      return;
    }
    const schedules = engine.schedules();
    const lastFinish = new Map(
      schedules.flatMap((schedule) => {
        const finish =
          state === undefined ? undefined : readLastFinish(state, schedule.key);
        return finish === undefined ? [] : [[schedule.key, finish] as const];
      })
    );
    let startedAt = Date.now();
    const runningEngine = engine;
    const { harnesses, activities, automations } = runningEngine;
    const update = async () =>
      terminal.update(
        dashboardSnapshot(await runningEngine.runs(), {
          activities: activities.list(),
          automationErrors: automations.errors(),
          automations: automations.list(),
          definitions: runningEngine.definitions(),
          feed: await runningEngine.feed(),
          harnesses,
          lastFinish,
          monitors: runningEngine.monitors(),
          root: workspace.root,
          schedules: runningEngine.schedules(),
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
      async deleteTrigger(id) {
        automations.delete(id);
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
      async setTriggerEnabled(id, enabled) {
        automations.setEnabled(id, enabled);
        await update();
      },
      steer(runId, stepId, prompt) {
        runningEngine.steer(runId, stepId, prompt);
        return Promise.resolve();
      },
      async stopActivity(sessionId, activityId) {
        await activities.stop(sessionId, activityId);
        await update();
      },
      stream: (runId, signal) => runningEngine.stream(runId, signal),
    });
    terminal.setLauncher(async (name, input) => {
      if (!runningEngine.definitions().some((entry) => entry.name === name)) {
        throw new Error("This definition is not available for manual launch.");
      }
      const values =
        typeof input === "object" && input !== null && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      // The factory is the one parser: it validates at dispatch, a bad value
      // rejects the launch and the form shows that, and a transform runs once.
      const launched = await runningEngine.launch(
        name,
        inputFromFields(values)
      );
      launched.result.catch((error: unknown) =>
        print(`[run] ${String(error)}`)
      );
      await update();
      return launched.id;
    });
    postSetupMilestone(runningEngine, print, createdDraft, {
      configPath: createdFile ?? configPath,
      root: workspace.root,
    });
    status = hasConfig
      ? "Marbles loaded"
      : "No authoring folder found · run marbles init";
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
      print,
      () => runningEngine.schedules()
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
        await built?.dispose();
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

async function stopAfterSchedules(
  loop: Promise<void> | undefined,
  engine: Engine | undefined
): Promise<void> {
  try {
    await loop;
  } finally {
    await engine?.stop({ cancel: true });
  }
}
