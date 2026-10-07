import { basename } from "node:path";
import type { Flags } from "~/args";
import { catalog } from "~/authoring/catalog";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { openDashboard } from "~/dashboard/terminal";
import { hostEngine, loadSource, openWorkspace, touchWorkspace } from "~/host";
import type { Engine } from "~/lib/engine";
import { inputFromFields } from "~/lib/schema";
import { lastFinish as recordedFinish } from "~/lib/state/schedules";
import { createStarter } from "~/onboarding/create";
import {
  registerSetupStep,
  SETUP_STEP,
  type SetupInput,
} from "~/onboarding/setup-step";
import type { SetupDraft } from "~/onboarding/templates";
import { runSchedulesUntilStopped } from "~/run-loop";
import { resolveSource, sourceRoot } from "~/source";

export async function runInteractive(args: Flags): Promise<void> {
  const controller = new AbortController();
  const terminal = await openDashboard(
    basename(sourceRoot(resolveSource(args.config))),
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
  // The one place this process stops on a signal: the schedule loop below
  // is handed the controller's signal and registers none of its own.
  controller.signal.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const opened = await openWorkspace(args, {
      onMissing: async (missing) =>
        !controller.signal.aborted &&
        (await terminal.onboard(missing, async (draft) => {
          createdFile = await createStarter(missing, draft);
          createdDraft = draft;
          try {
            await loadSource(missing, print);
          } catch (error) {
            catalog.reset();
            throw new Error(
              `Starter was created but could not load: ${String(error)}. Fix it and restart Marbles.`,
              { cause: error }
            );
          }
        })),
      print,
    });
    if (controller.signal.aborted) {
      return;
    }
    const { config, configPath, workspace } = opened;
    const hasConfig = config !== null;
    built = hostEngine(args, opened, { askable: true, print });
    registerSetupStep(built);
    engine = await built.start();
    if (controller.signal.aborted) {
      return;
    }
    const { store } = engine;
    const schedules = engine.schedules();
    const lastFinish = new Map(
      schedules.flatMap((schedule) => {
        const finish = recordedFinish(store, schedule.key);
        return finish === undefined ? [] : [[schedule.key, finish] as const];
      })
    );
    let startedAt = Date.now();
    const runningEngine = engine;
    const { activities, automations } = runningEngine;
    const update = async () =>
      terminal.update(
        dashboardSnapshot(await runningEngine.runs(), {
          activities: activities.list(),
          automationErrors: automations.errors(),
          automations: automations.list(),
          definitions: runningEngine.definitions(),
          feed: await runningEngine.feed(),
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
    terminal.connect({
      async answer(entryId, answer) {
        await runningEngine.answer(entryId, answer);
        await update();
      },
      async launch(name, input) {
        if (!runningEngine.definitions().some((entry) => entry.name === name)) {
          throw new Error(
            "This definition is not available for manual launch."
          );
        }
        // The factory is the one parser: it validates at dispatch, a bad
        // value rejects the launch and the form shows that, and a transform
        // runs once.
        const launched = await runningEngine.launch(
          name,
          inputFromFields(input ?? {})
        );
        launched.result.catch((error: unknown) =>
          print(`[run] ${String(error)}`)
        );
        await update();
        return launched.id;
      },
      runs: {
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
      },
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
    touchWorkspace(runningEngine, opened);
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
    loop = runSchedulesUntilStopped(runningEngine, {
      config,
      print,
      signal: controller.signal,
    });
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
