import { basename } from "node:path";
import type { Flags } from "~/args";
import { catalog } from "~/authoring/catalog";
import { openDashboard } from "~/dashboard/terminal";
import type { Engine } from "~/lib/engine";
import type { DashboardSnapshot } from "~/model/dashboard";
import { createStarter } from "~/workspace/create";
import type { WorkspaceHost } from "~/workspace/host";
import { hostWorkspace } from "~/workspace/host";
import { loadSource } from "~/workspace/open";
import {
  registerSetupStep,
  SETUP_STEP,
  type SetupInput,
} from "~/workspace/setup-step";
import { resolveSource, sourceRoot } from "~/workspace/source";
import type { SetupDraft } from "~/workspace/templates";

/** How often the dashboard asks for a fresh snapshot. */
const REFRESH_MS = 200;

export async function runInteractive(args: Flags): Promise<void> {
  const controller = new AbortController();
  const terminal = await openDashboard(
    basename(sourceRoot(resolveSource(args.config))),
    controller
  );
  const print = (line: string) => {
    host?.setStatus(line);
  };
  let host: WorkspaceHost | undefined;
  let createdDraft: SetupDraft | undefined;
  let createdFile: string | undefined;
  let loop: Promise<void> | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    controller.abort();
    stopping ??= stopAfterSchedules(loop, host?.engine);
    // Attach immediately: cleanup below awaits and reports any failure.
    stopping?.catch(() => undefined);
  };
  // The one place this process stops on a signal: the schedule loop below
  // is handed the controller's signal and registers none of its own.
  controller.signal.addEventListener("abort", stop, { once: true });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    host = await hostWorkspace({
      artifacts: args.artifacts,
      askable: true,
      dry: args.dry,
      only: args.only,
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
      prepare: registerSetupStep,
      print,
      source: args.config,
      state: args.state,
    });
    if (controller.signal.aborted) {
      return;
    }
    const running = host;
    const hasConfig = running.config !== null;
    const shown = (snapshot: DashboardSnapshot): DashboardSnapshot =>
      args.dry ? { ...snapshot, status: `dry · ${snapshot.status}` } : snapshot;
    const update = async () =>
      terminal.update(shown(await running.snapshot()), hasConfig);
    terminal.connect(running.actions);
    postSetupMilestone(running.engine, print, createdDraft, {
      configPath: createdFile ?? running.configPath,
      root: running.root,
    });
    running.setStatus(
      hasConfig
        ? "Marbles loaded"
        : "No authoring folder found · run marbles init"
    );
    await update();
    if (!(await terminal.entry)) {
      return;
    }
    running.setStatus(
      running.engine.schedules().length === 0
        ? "Ready · no triggers configured"
        : "Watching triggers"
    );
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
    }, REFRESH_MS);
    loop = running.run(controller.signal);
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
        await host?.close();
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
