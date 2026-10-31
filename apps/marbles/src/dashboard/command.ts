import { basename } from "node:path";
import type { Flags } from "~/args";
import { catalog } from "~/authoring/catalog";
import { openDashboard } from "~/dashboard/terminal";
import { layout } from "~/layout";
import type { Engine } from "~/lib/engine";
import type { WorkspaceConnection, WorkspaceSummary } from "~/model/connection";
import type { DashboardSnapshot } from "~/model/dashboard";
import type { MarblesClient } from "~/process/client";
import { connect } from "~/process/client";
import type { HostedWorkspace } from "~/views/use-dashboard";
import { createStarter } from "~/workspace/create";
import type { WorkspaceHost } from "~/workspace/host";
import { hostWorkspace } from "~/workspace/host";
import { loadSource } from "~/workspace/open";
import {
  registerSetupStep,
  SETUP_STEP,
  type SetupInput,
} from "~/workspace/setup-step";
import { resolveSource, sourceFiles, sourceRoot } from "~/workspace/source";
import type { SetupDraft } from "~/workspace/templates";

/** How often the dashboard asks for a fresh snapshot. */
const REFRESH_MS = 200;
/** How often the dashboard asks the Marbles process which workspaces it hosts. */
const WORKSPACES_REFRESH_MS = 3000;

type Terminal = Awaited<ReturnType<typeof openDashboard>>;

/**
 * The dashboard. Under `--dry-run` the workspace is hosted in this process
 * and quitting stops it; otherwise it is attached to the Marbles process,
 * which keeps hosting it after the dashboard closes.
 */
export async function runInteractive(args: Flags): Promise<void> {
  const controller = new AbortController();
  const terminal = await openDashboard(
    basename(sourceRoot(resolveSource(args.config))),
    controller
  );
  // The one place this process stops on a signal: everything below is
  // handed the controller's signal and registers none of its own.
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await (args.dry ? runLocal : runRemote)(args, terminal, controller);
  } catch (error) {
    process.exitCode = 1;
    if (!controller.signal.aborted) {
      await terminal.failure(error);
    }
  } finally {
    stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    terminal.close();
  }
}

/** Refresh on an interval, one request at a time, until the signal aborts. */
function every(
  ms: number,
  signal: AbortSignal,
  work: () => Promise<void>
): () => void {
  let updating = false;
  const timer = setInterval(() => {
    if (updating || signal.aborted) {
      return;
    }
    updating = true;
    work()
      .catch(() => undefined)
      .finally(() => {
        updating = false;
      });
  }, ms);
  return () => clearInterval(timer);
}

async function runLocal(
  args: Flags,
  terminal: Terminal,
  controller: AbortController
): Promise<void> {
  const print = (line: string) => {
    host?.setStatus(line);
  };
  let host: WorkspaceHost | undefined;
  let createdDraft: SetupDraft | undefined;
  let createdFile: string | undefined;
  let loop: Promise<void> | undefined;
  let refresh: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= stopAfterSchedules(loop, host?.engine);
    // Attach immediately: cleanup below awaits and reports any failure.
    stopping.catch(() => undefined);
  };
  controller.signal.addEventListener("abort", stop, { once: true });
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
    const shown = (snapshot: DashboardSnapshot): DashboardSnapshot => ({
      ...snapshot,
      status: `dry · ${snapshot.status}`,
    });
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
    refresh = every(REFRESH_MS, controller.signal, () =>
      update().catch((error: unknown) => {
        print(`[dashboard] ${String(error)}`);
      })
    );
    loop = running.run(controller.signal);
    await loop;
  } finally {
    refresh?.();
    // Stop the engine here; the controller is aborted by whoever ends the
    // session, so a failure still gets its screen before the terminal closes.
    stop();
    try {
      await stopping;
      await loop;
    } finally {
      controller.signal.removeEventListener("abort", stop);
      await host?.close();
    }
  }
}

/**
 * Attach the workspace to the Marbles process and show it from there. The
 * dashboard polls the worker's snapshot while it is ready and shows the
 * worker's state otherwise; `w` moves to the next hosted workspace. Closing
 * the client detaches: the process keeps hosting every workspace.
 */
async function runRemote(
  args: Flags,
  terminal: Terminal,
  controller: AbortController
): Promise<void> {
  const configPath = resolveSource(args.config);
  const client = await connect({
    layout: layout({ artifacts: args.artifacts, state: args.state }),
    only: args.only,
  });
  try {
    if (controller.signal.aborted) {
      return;
    }
    let attached: WorkspaceSummary | undefined;
    if (sourceFiles(configPath) === undefined) {
      // The worker posts the setup milestone; a starter that will not load
      // fails the attach, and the onboarding view shows why.
      await terminal.onboard(configPath, async (draft) => {
        await createStarter(configPath, draft);
        attached = await client.attach(configPath, { setup: draft });
      });
      if (controller.signal.aborted) {
        return;
      }
    }
    attached ??= await client.attach(configPath);
    if (controller.signal.aborted) {
      return;
    }
    const session = remoteSession(client, attached, terminal);
    await session.refresh();
    if (!(await terminal.entry)) {
      return;
    }
    const stopRefresh = every(REFRESH_MS, controller.signal, session.refresh);
    const stopListing = every(
      WORKSPACES_REFRESH_MS,
      controller.signal,
      session.refreshList
    );
    try {
      const aborted = new Promise<"quit">((resolve) =>
        controller.signal.addEventListener("abort", () => resolve("quit"), {
          once: true,
        })
      );
      const gone = client.closed.then(() => "gone" as const);
      if ((await Promise.race([aborted, gone])) === "gone") {
        throw new Error(
          "the Marbles process stopped; run marbles to start it again"
        );
      }
    } finally {
      stopRefresh();
      stopListing();
      session.close();
    }
  } finally {
    client.close();
  }
}

/** The worker's state as the dashboard's status line reads it. */
function describeState(summary: WorkspaceSummary): string {
  return summary.error === undefined
    ? `workspace ${summary.state}`
    : `workspace ${summary.state}: ${summary.error}`;
}

/** What the dashboard shows for a workspace whose worker is not ready. */
function placeholderSnapshot(
  summary: WorkspaceSummary,
  feed: DashboardSnapshot["feed"]
): DashboardSnapshot {
  return {
    definitions: [],
    feed,
    mode: "live",
    runs: [],
    status: describeState(summary),
    triggers: [],
    workspace: basename(summary.root),
    workspaceId: summary.id,
  };
}

/**
 * The dashboard's view of the Marbles process: the workspaces it hosts, the
 * one shown, and the snapshot polling that follows it when it changes.
 */
function remoteSession(
  client: MarblesClient,
  attached: WorkspaceSummary,
  terminal: Terminal
) {
  let workspaces: readonly WorkspaceSummary[] = [attached];
  let currentId = attached.id;
  let connection: WorkspaceConnection = client.workspace(attached);
  let lastSnapshot: DashboardSnapshot | undefined;
  const subscriptions = new Map<string, () => void>();

  const current = (): WorkspaceSummary =>
    workspaces.find((summary) => summary.id === currentId) ?? attached;

  const hosted = (): HostedWorkspace => {
    const summary = current();
    const position = workspaces.findIndex((item) => item.id === summary.id);
    return {
      count: workspaces.length,
      ...(summary.error === undefined ? {} : { error: summary.error }),
      position: position === -1 ? 1 : position + 1,
      state: summary.state,
    };
  };

  const publish = (snapshot: DashboardSnapshot): void => {
    lastSnapshot = snapshot;
    terminal.update(snapshot, current().config !== null, hosted());
  };

  /** The last snapshot again, or a placeholder, under the state as it is now. */
  const republish = (): void => {
    const summary = current();
    publish(
      summary.state === "ready" && lastSnapshot
        ? lastSnapshot
        : placeholderSnapshot(summary, lastSnapshot?.feed ?? [])
    );
  };

  const remember = (summary: WorkspaceSummary): void => {
    const index = workspaces.findIndex((item) => item.id === summary.id);
    workspaces =
      index === -1 ? [...workspaces, summary] : workspaces.with(index, summary);
    if (summary.id === currentId) {
      republish();
    }
  };

  const follow = (summary: WorkspaceSummary): void => {
    if (subscriptions.has(summary.id)) {
      return;
    }
    subscriptions.set(
      summary.id,
      client.subscribe(summary.id, { workspace: remember })
    );
  };
  follow(attached);

  const show = (summary: WorkspaceSummary): void => {
    currentId = summary.id;
    connection = client.workspace(summary);
    lastSnapshot = undefined;
    terminal.connect({ ...connection.actions, switchWorkspace });
    republish();
  };

  function switchWorkspace(): void {
    const index = workspaces.findIndex((item) => item.id === currentId);
    const next = workspaces[(index + 1) % workspaces.length];
    if (next && next.id !== currentId) {
      show(next);
    }
  }
  terminal.connect({ ...connection.actions, switchWorkspace });

  async function refreshList(): Promise<void> {
    const listed = await client.workspaces();
    if (listed.length === 0) {
      return;
    }
    workspaces = listed;
    for (const summary of listed) {
      follow(summary);
    }
    const [first] = listed;
    if (first && !listed.some((summary) => summary.id === currentId)) {
      show(first);
      return;
    }
    republish();
  }

  /** One snapshot of the workspace shown; its state instead while the worker is not ready. */
  async function refresh(): Promise<void> {
    const summary = current();
    if (summary.state !== "ready") {
      republish();
      return;
    }
    const polled = connection;
    try {
      const snapshot = await polled.snapshot();
      if (polled === connection) {
        publish(snapshot);
      }
    } catch (error) {
      if (polled !== connection) {
        return;
      }
      // The daemon's answer names the state the worker is in; the list
      // catches the header up with it.
      publish({
        ...(lastSnapshot ?? placeholderSnapshot(summary, [])),
        status: String(error instanceof Error ? error.message : error),
      });
      await refreshList();
    }
  }

  return {
    close(): void {
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }
      subscriptions.clear();
    },
    refresh,
    refreshList,
  };
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
