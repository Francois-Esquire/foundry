import { basename } from "node:path";
import type { Flags } from "~/args";
import { catalog } from "~/authoring/catalog";
import { applyTheme } from "~/components/ui/theme";
import { Diagnostics, hostOutput } from "~/dashboard/diagnostics";
import { dashboardSnapshot } from "~/dashboard/snapshot";
import { openDashboard } from "~/dashboard/terminal";
import { hostEngine, loadSource, openWorkspace, touchWorkspace } from "~/host";
import type { Engine } from "~/lib/engine";
import { inputFromFields } from "~/lib/schema";
import { lastFinish as recordedFinish } from "~/lib/state/schedules";
import type { SettingsChange } from "~/model/settings";
import { createStarter } from "~/onboarding/create";
import {
  registerSetupStep,
  SETUP_STEP,
  type SetupInput,
} from "~/onboarding/setup-step";
import type { SetupDraft } from "~/onboarding/templates";
import { runSchedulesUntilStopped } from "~/run-loop";
import { loadSettings, saveSettings, settingsPath } from "~/settings";
import { resolveSource, sourceRoot } from "~/source";

export async function runInteractive(args: Flags): Promise<void> {
  const controller = new AbortController();
  // Global preferences apply before the first frame.
  let settings = loadSettings(settingsPath(args.state));
  applyTheme(settings.settings.theme);
  const diagnostics = new Diagnostics();
  if (settings.problem) {
    diagnostics.add(`[settings] ${settings.problem}`, "warn");
  }
  const terminal = await openDashboard(
    basename(sourceRoot(resolveSource(args.config))),
    controller
  );
  let status = "Loading marbles";
  const { log, print } = hostOutput(diagnostics, (line) => {
    status = line;
  });
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
    built = await hostEngine(args, opened, { askable: true, log, print });
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
          diagnostics: diagnostics.entries,
          feed: await runningEngine.feed(),
          lastFinish,
          monitors: runningEngine.monitors(),
          root: workspace.root,
          schedules: runningEngine.schedules(),
          settings: {
            path: settings.path,
            ...(settings.problem ? { problem: settings.problem } : {}),
            theme: settings.settings.theme,
          },
          setupLogs: diagnostics.setupEntries,
          startedAt,
          status: args.dry ? `dry · ${status}` : status,
          usage: await runningEngine.readUsage(),
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
        launched.result.catch((error: unknown) => {
          status = `[run] ${String(error)}`;
          diagnostics.add(status, "error");
        });
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
      // A dry run leaves the state root, where settings live, as it found it.
      ...(args.dry
        ? {}
        : {
            async settings(changes: SettingsChange) {
              const saved = saveSettings(settings.path, changes);
              settings = { path: settings.path, settings: saved };
              applyTheme(saved.theme);
              diagnostics.add(`[settings] theme ${saved.theme}`);
              await update();
            },
          }),
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
          status = `[dashboard] ${String(error)}`;
          diagnostics.add(status, "error");
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
