import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useSyncExternalStore } from "react";
import { theme } from "~/components/ui/theme";
import type { SetupDraft } from "~/onboarding/templates";
import { ConfigErrorView } from "~/views/config-error";
import { DashboardView } from "~/views/dashboard";
import type { DashboardSnapshot } from "~/views/dashboard-model";
import { OnboardingView } from "~/views/onboarding";
import type { Launcher, RunActions } from "~/views/run-actions";
import { SplashView } from "~/views/splash";
import { summarizeConfig } from "~/views/splash-model";
import type { AnswerHandler } from "~/views/use-feed";

/** What the dashboard can do in the host once its engine runs; published once. */
interface HostActions {
  readonly answer: AnswerHandler;
  readonly launch: Launcher;
  readonly runs: RunActions;
}

interface Screen {
  readonly entered: boolean;
  readonly error?: string;
  /** Whether a source was loaded; read with the first snapshot. */
  readonly hasConfig: boolean;
  /** Absent until the engine runs: the splash and onboarding need none. */
  readonly host?: HostActions;
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
  const { entered, snapshot, setup, error, hasConfig, host } =
    useSyncExternalStore(store.subscribe, store.getSnapshot);
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
        actions={host?.runs}
        onAnswer={host?.answer}
        onClose={onClose}
        onLaunch={host?.launch}
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
    update(snapshot: DashboardSnapshot, hasConfig: boolean) {
      publish({ ...screen, hasConfig, snapshot });
    },
  };
}
