import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useSyncExternalStore } from "react";
import { useTheme } from "~/hooks/use-theme";
import { DashboardView } from "~/views/dashboard";
import type { DashboardSnapshot } from "~/views/dashboard-model";
import { SplashView } from "~/views/splash";
import { summarizeConfig } from "~/views/splash-model";

interface Screen {
  readonly entered: boolean;
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
  const { entered, snapshot } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot
  );
  if (entered && snapshot) {
    return (
      <DashboardView
        onClose={onClose}
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
          ? { counts: summarizeConfig(snapshot), status: "ready" }
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
    update(snapshot: DashboardSnapshot) {
      publish({ ...screen, snapshot });
    },
  };
}
