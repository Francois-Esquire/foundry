import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  createElement,
  type ReactNode,
  useState,
  useSyncExternalStore,
} from "react";
import type { DashboardSnapshot } from "~/cli/state/dashboard-model";
import type { Launcher, RunActions } from "~/cli/state/run-actions";
import { summarizeConfig } from "~/cli/state/splash-model";
import type { HostedWorkspace } from "~/cli/state/use-dashboard";
import type { AnswerHandler } from "~/cli/state/use-feed";
import { ConfigErrorView } from "~/cli/views/config-error";
import { DashboardView } from "~/cli/views/dashboard";
import { OnboardingView } from "~/cli/views/onboarding";
import {
  ProviderOnboarding,
  WorkspaceWelcome,
} from "~/cli/views/onboarding-intro";
import { SplashView } from "~/cli/views/splash";
import { theme } from "~/components/ui/theme";
import type { SettingsChange } from "~/model/settings";
import type { discoverProviderSetup } from "~/workspace/provider-setup";
import type { SetupDraft } from "~/workspace/templates";

const ROUTINE_STATUS = new Set([
  "Ready · no triggers configured",
  "Watching triggers",
]);

interface HostActions {
  readonly answer: AnswerHandler;
  readonly launch: Launcher;
  readonly rollSchedule?: (key: string) => Promise<void>;
  readonly runs: RunActions;
  readonly settings?: (changes: SettingsChange) => Promise<void>;
  readonly switchWorkspace?: (id: string) => void;
}

interface Screen {
  readonly entered: boolean;
  readonly error?: string;
  readonly hasConfig: boolean;
  readonly host?: HostActions;
  readonly hosted?: HostedWorkspace;
  readonly setup?: ReactNode;
  readonly snapshot?: DashboardSnapshot;
}
interface ScreenStore {
  getSnapshot(): Screen;
  subscribe(listener: () => void): () => void;
}

function DashboardApp({
  store,
  workspace,
  onEnter,
  onClose,
}: {
  readonly store: ScreenStore;
  readonly workspace: string;
  readonly onEnter: () => void;
  readonly onClose: () => void;
}) {
  const { entered, snapshot, setup, error, hasConfig, host, hosted } =
    useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [workspaceRail, setWorkspaceRail] = useState(false);
  if (error) {
    return <ConfigErrorView message={error} onClose={onClose} />;
  }
  if (setup) {
    return setup;
  }
  if (entered && snapshot) {
    return (
      <DashboardView
        actions={host?.runs}
        hosted={hosted}
        key={snapshot.workspaceId ?? snapshot.workspace}
        onAnswer={host?.answer}
        onClose={onClose}
        onLaunch={host?.launch}
        onRollSchedule={host?.rollSchedule}
        onSettings={host?.settings}
        onSwitchWorkspace={host?.switchWorkspace}
        onWorkspaceRail={setWorkspaceRail}
        snapshot={snapshot}
        toolbar={
          ROUTINE_STATUS.has(snapshot.status) ? undefined : (
            <text fg={theme.colors.mutedForeground} wrapMode="none">
              {snapshot.status}
            </text>
          )
        }
        workspaceRail={workspaceRail}
      />
    );
  }
  return (
    <SplashView
      onClose={onClose}
      onEnter={onEnter}
      preview={false}
      state={
        snapshot
          ? { counts: summarizeConfig(snapshot), hasConfig, status: "ready" }
          : { status: "loading" }
      }
      workspace={snapshot?.workspace ?? workspace}
    />
  );
}

export async function openDashboard(
  workspace: string,
  controller: AbortController
) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const listeners = new Set<() => void>();
  let screen: Screen = { entered: false, hasConfig: false };
  const store: ScreenStore = {
    getSnapshot: () => screen,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  function publish(next: Screen) {
    if (controller.signal.aborted) {
      return;
    }
    screen = next;
    for (const listener of listeners) {
      listener();
    }
  }
  let finish: (entered: boolean) => void = () => undefined;
  const entry = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  let closed = false;
  const actions = {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      controller.abort();
      finish(false);
      renderer.destroy();
    },
    enter() {
      if (!screen.snapshot || controller.signal.aborted) {
        return;
      }
      publish({ ...screen, entered: true });
      finish(true);
    },
  };
  controller.signal.addEventListener("abort", actions.close, { once: true });
  renderer.once("destroy", () => {
    controller.signal.removeEventListener("abort", actions.close);
    controller.abort();
    finish(false);
    listeners.clear();
  });
  createRoot(renderer).render(
    <DashboardApp
      onClose={actions.close}
      onEnter={actions.enter}
      store={store}
      workspace={workspace}
    />
  );
  function showSetup(
    render: (finish: (completed: boolean) => void) => ReactNode
  ): Promise<boolean> {
    if (controller.signal.aborted) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const abort = () => resolve(false);
      controller.signal.addEventListener("abort", abort, { once: true });
      const finishSetup = (completed: boolean) => {
        controller.signal.removeEventListener("abort", abort);
        publish({ ...screen, setup: undefined });
        resolve(completed);
      };
      publish({ ...screen, setup: render(finishSetup) });
    });
  }
  return {
    close: actions.close,
    connect(host: HostActions) {
      publish({ ...screen, host });
    },
    entry,
    async failure(error: unknown) {
      publish({ ...screen, error: String(error), setup: undefined });
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          })
        );
      }
    },
    onboard(
      path: string,
      root: string,
      create: (draft: SetupDraft) => Promise<void>
    ): Promise<boolean> {
      return showSetup((finishSetup) =>
        createElement(OnboardingView, {
          onClose: actions.close,
          onCreate: async (draft: SetupDraft) => {
            await create(draft);
            finishSetup(true);
          },
          onSkip: () => finishSetup(false),
          path,
          workspace: root,
        })
      );
    },
    reviewProviders(
      root: string,
      review: Awaited<ReturnType<typeof discoverProviderSetup>>,
      confirm: (useDetected: boolean) => Promise<void>
    ): Promise<boolean> {
      return showSetup((finishSetup) =>
        createElement(ProviderOnboarding, {
          onClose: actions.close,
          onContinue: async (useDetected: boolean) => {
            await confirm(useDetected);
            finishSetup(true);
          },
          review,
          workspace: root,
        })
      );
    },
    update(
      snapshot: DashboardSnapshot,
      hasConfig: boolean,
      hosted?: HostedWorkspace
    ) {
      publish({ ...screen, hasConfig, hosted, snapshot });
    },
    welcome(path: string, root: string): Promise<boolean> {
      return showSetup((finishSetup) =>
        createElement(WorkspaceWelcome, {
          onClose: actions.close,
          onContinue: async () => finishSetup(true),
          path,
          workspace: root,
        })
      );
    },
  };
}
