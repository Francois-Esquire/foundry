import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useSyncExternalStore } from "react";
import { useTheme } from "~/hooks/use-theme";
import type { SetupDraft } from "~/onboarding/templates";
import { ConfigErrorView } from "~/views/config-error";
import { DashboardView } from "~/views/dashboard";
import type { DashboardSnapshot } from "~/views/dashboard-model";
import { OnboardingView } from "~/views/onboarding";
import type { RunActions } from "~/views/run-actions";
import { SplashView } from "~/views/splash";
import { summarizeConfig } from "~/views/splash-model";
import type { AnswerHandler } from "~/views/use-feed";

interface Screen {
  readonly actions?: RunActions;
  readonly entered: boolean;
  readonly error?: string;
  readonly hasConfig?: boolean;
  readonly onAnswer?: AnswerHandler;
  readonly onLaunch?: (name: string, input: unknown) => Promise<string>;
  readonly setup?: {
    readonly path: string;
    readonly onCreate: (draft: SetupDraft) => Promise<void>;
    readonly onSkip: () => void;
  };
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
  const theme = useTheme();
  const {
    actions,
    entered,
    snapshot,
    setup,
    error,
    hasConfig,
    onAnswer,
    onLaunch,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  if (error) {
    return <ConfigErrorView message={error} onClose={onClose} />;
  }
  if (setup) {
    return (
      <OnboardingView
        onClose={onClose}
        onCreate={setup.onCreate}
        onSkip={setup.onSkip}
        path={setup.path}
      />
    );
  }
  if (entered && snapshot) {
    return (
      <DashboardView
        actions={actions}
        onAnswer={onAnswer}
        onClose={onClose}
        onLaunch={onLaunch}
        snapshot={snapshot}
        toolbar={
          <text fg={theme.colors.mutedForeground} wrapMode="none">
            {snapshot.status}
          </text>
        }
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

/** Owns only the terminal lifecycle. Loading and execution stay with the command. */
export async function openDashboard(
  workspace: string,
  controller: AbortController
) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const listeners = new Set<() => void>();
  let screen: Screen = { entered: false };
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
  // OpenTUI creates a reconciler container on render(), so mount exactly once.
  createRoot(renderer).render(
    <DashboardApp
      onClose={actions.close}
      onEnter={actions.enter}
      store={store}
      workspace={workspace}
    />
  );
  return {
    close: actions.close,
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
      create: (draft: SetupDraft) => Promise<void>
    ): Promise<boolean> {
      return new Promise((resolve) => {
        const abort = () => resolve(false);
        controller.signal.addEventListener("abort", abort, { once: true });
        const finishSetup = (created: boolean) => {
          controller.signal.removeEventListener("abort", abort);
          publish({ ...screen, setup: undefined });
          resolve(created);
        };
        publish({
          ...screen,
          setup: {
            onCreate: async (draft) => {
              await create(draft);
              finishSetup(true);
            },
            onSkip: () => finishSetup(false),
            path,
          },
        });
      });
    },
    setAnswerer(onAnswer: AnswerHandler) {
      publish({ ...screen, onAnswer });
    },
    setLauncher(onLaunch: (name: string, input: unknown) => Promise<string>) {
      publish({ ...screen, onLaunch });
    },
    setRunActions(runActions: RunActions) {
      publish({ ...screen, actions: runActions });
    },
    update(snapshot: DashboardSnapshot, hasConfig = true) {
      publish({ ...screen, hasConfig, snapshot });
    },
  };
}
