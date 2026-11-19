import { basename } from "node:path";
import type { Flags } from "~/args";
import { applyTheme } from "~/components/ui/theme";
import { openDashboard } from "~/dashboard/terminal";
import { layout } from "~/layout";
import type { Engine } from "~/lib/engine";
import type { WorkspaceConnection, WorkspaceSummary } from "~/model/connection";
import type { DashboardSnapshot } from "~/model/dashboard";
import type { LogEntry } from "~/model/log";
import type { SettingsChange } from "~/model/settings";
import type { MarblesClient } from "~/process/client";
import { connect } from "~/process/client";
import { loadSettings, saveSettings, settingsPath } from "~/settings";
import type { HostedWorkspace } from "~/views/use-dashboard";
import { createStarter } from "~/workspace/create";
import { Diagnostics } from "~/workspace/diagnostics";
import type { WorkspaceHost } from "~/workspace/host";
import { hostWorkspace } from "~/workspace/host";
import { findWorkspace, recordedWorkspace } from "~/workspace/open";
import { discoverProviderSetup } from "~/workspace/provider-setup";
import { resolveSource, sourceRoot } from "~/workspace/source";
import type { SetupDraft } from "~/workspace/templates";

const REFRESH_MS = 200;
const WORKSPACES_REFRESH_MS = 3000;

type Terminal = Awaited<ReturnType<typeof openDashboard>>;

export async function runInteractive(args: Flags): Promise<void> {
  const controller = new AbortController();
  const local = localState(args);
  const onboarding = args.dry ? undefined : await onboardingFor(args, local);
  const terminal = await openDashboard(
    basename(
      onboarding?.root ?? sourceRoot(resolveSource(args.config, args.directory))
    ),
    controller
  );
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    if (onboarding) {
      await runRemote(terminal, controller, local, onboarding);
    } else {
      await runLocal(args, terminal, controller, local);
    }
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

interface LocalState {
  readonly decorate: (snapshot: DashboardSnapshot) => DashboardSnapshot;
  readonly report: (line: string, level?: LogEntry["level"]) => void;
  readonly save?: (changes: SettingsChange) => void;
}

function localState(args: Flags): LocalState {
  let loaded = loadSettings(settingsPath(args.state));
  applyTheme(loaded.settings.theme);
  const diagnostics = new Diagnostics();
  if (loaded.problem) {
    diagnostics.add(`[settings] ${loaded.problem} (${loaded.path})`, "warn");
  }
  return {
    decorate: (snapshot) => ({
      ...snapshot,
      diagnostics: [
        ...(snapshot.diagnostics ?? []),
        ...diagnostics.entries.map((entry) => ({
          ...entry,
          id: `dashboard:${entry.id}`,
        })),
      ],
      settings: {
        path: loaded.path,
        ...(loaded.problem ? { problem: loaded.problem } : {}),
        theme: loaded.settings.theme,
      },
    }),
    report: (line, level) => diagnostics.add(line, level),
    ...(args.dry
      ? {}
      : {
          save(changes: SettingsChange) {
            const saved = saveSettings(loaded.path, changes);
            loaded = { path: loaded.path, settings: saved };
            applyTheme(saved.theme);
            diagnostics.add(`[settings] theme ${saved.theme}`);
          },
        }),
  };
}

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
  controller: AbortController,
  local: LocalState
): Promise<void> {
  const print = (line: string) => {
    host?.setStatus(line);
  };
  let host: WorkspaceHost | undefined;
  let loop: Promise<void> | undefined;
  let refresh: (() => void) | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= stopAfterSchedules(loop, host?.engine);
    stopping.catch(() => undefined);
  };
  controller.signal.addEventListener("abort", stop, { once: true });
  try {
    host = await hostWorkspace({
      artifacts: args.artifacts,
      askable: true,
      directory: args.directory,
      dry: args.dry,
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
      ...local.decorate(snapshot),
      status: `dry · ${snapshot.status}`,
    });
    const update = async () =>
      terminal.update(shown(await running.snapshot()), hasConfig);
    terminal.connect({
      ...running.actions,
      rollSchedule: (key) => rollSchedule(running, key),
    });
    running.setStatus(hasConfig ? "Marbles loaded" : NO_SOURCE_WHEN_DRY);
    await update();
    if (!(await terminal.entry)) {
      return;
    }
    running.setStatus(await readyStatus(running.engine, hasConfig));
    await update();
    refresh = every(REFRESH_MS, controller.signal, () =>
      update().catch((error: unknown) => {
        const line = `[dashboard] ${String(error)}`;
        print(line);
        local.report(line, "error");
      })
    );
    loop = running.run(controller.signal);
    await loop;
  } finally {
    refresh?.();
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

async function rollSchedule(
  connection: Pick<WorkspaceConnection, "roll">,
  key: string
): Promise<void> {
  const { skipped } = await connection.roll(key);
  if (skipped !== undefined) {
    throw new Error(`Schedule ${key} skipped: ${skipped}`);
  }
}

async function onboardingFor(args: Flags, local: LocalState) {
  const { configPath, workspace, config } = findWorkspace(args);
  const path = settingsPath(args.state);
  const { settings, problem } = loadSettings(path);
  const [recorded, providers] = await Promise.all([
    recordedWorkspace(args, workspace.id),
    discoverProviderSetup({
      recheck: args.recheckProviders,
      state: args.state,
      workspace,
    }),
  ]);
  const firstSetup = !(providers.configured || settings.providerSetupComplete);
  const failedSettingsWithoutOffers =
    problem !== undefined &&
    recorded !== undefined &&
    providers.offered.length === 0;
  const reviewFirstSetup = firstSetup && !failedSettingsWithoutOffers;
  return {
    async completeProviders(useDetected: boolean) {
      if (useDetected) {
        const result = await providers.save();
        if (result.conflict) {
          throw new Error(result.message);
        }
      } else if (!(providers.configured || settings.providerSetupComplete)) {
        try {
          saveSettings(path, { providerSetupComplete: true });
        } catch (error) {
          local.report(
            `[settings] could not record provider setup: ${String(error)}`,
            "warn"
          );
        }
      }
    },
    configPath,
    hasSource: config !== null,
    providers:
      args.recheckProviders || reviewFirstSetup ? providers : undefined,
    root: workspace.root,
    workspaceSetup:
      reviewFirstSetup ||
      recorded === undefined ||
      (recorded.config !== null && config === null),
  };
}

async function runRemote(
  terminal: Terminal,
  controller: AbortController,
  local: LocalState,
  onboarding: Awaited<ReturnType<typeof onboardingFor>>
): Promise<void> {
  const { configPath, root, providers, hasSource, workspaceSetup } = onboarding;
  if (
    providers &&
    !(await terminal.reviewProviders(
      root,
      providers,
      onboarding.completeProviders
    ))
  ) {
    return;
  }
  let setup: SetupDraft | undefined;
  if (workspaceSetup) {
    if (hasSource) {
      await terminal.welcome(configPath, root);
    } else {
      await terminal.onboard(configPath, root, async (draft) => {
        await createStarter(configPath, draft);
        setup = draft;
      });
    }
  }
  if (controller.signal.aborted) {
    return;
  }
  const client = await connect({
    layout: layout(),
  });
  try {
    if (controller.signal.aborted) {
      return;
    }
    const attached = await client.attach(configPath, { root, setup });
    if (controller.signal.aborted) {
      return;
    }
    const session = remoteSession(client, attached, terminal, local);
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

function describeState(summary: WorkspaceSummary): string {
  return summary.error === undefined
    ? `workspace ${summary.state}`
    : `workspace ${summary.state}: ${summary.error}`;
}

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

function remoteSession(
  client: MarblesClient,
  attached: WorkspaceSummary,
  terminal: Terminal,
  local: LocalState
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
    return {
      ...(summary.error === undefined ? {} : { error: summary.error }),
      state: summary.state,
      workspaces,
    };
  };

  const publish = (snapshot: DashboardSnapshot): void => {
    lastSnapshot = snapshot;
    terminal.update(
      local.decorate(snapshot),
      current().config !== null,
      hosted()
    );
  };

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

  const { save } = local;
  const settings = save
    ? async (changes: SettingsChange): Promise<void> => {
        save(changes);
        republish();
      }
    : undefined;
  const connectActions = (): void => {
    terminal.connect({
      ...connection.actions,
      ...(settings ? { settings } : {}),
      rollSchedule: (key) => rollSchedule(connection, key),
      switchWorkspace,
    });
  };

  const show = (summary: WorkspaceSummary): void => {
    currentId = summary.id;
    connection = client.workspace(summary);
    lastSnapshot = undefined;
    connectActions();
    republish();
  };

  function switchWorkspace(id: string): void {
    const next = workspaces.find((item) => item.id === id);
    if (next && next.id !== currentId) {
      show(next);
      refresh().catch((error: unknown) => local.report(String(error), "error"));
    }
  }
  connectActions();

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

const NO_SOURCE_WHEN_DRY =
  "No authoring folder · run marbles init without --dry-run";

async function readyStatus(
  engine: Engine,
  hasConfig: boolean
): Promise<string> {
  if (!hasConfig) {
    return NO_SOURCE_WHEN_DRY;
  }
  return (await engine.schedules()).length === 0
    ? "Ready · no triggers configured"
    : "Watching triggers";
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
