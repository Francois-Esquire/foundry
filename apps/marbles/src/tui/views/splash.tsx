import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useState } from "react";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { SplashCard } from "~/components/blocks/splash-card";
import { SplashLayout, type Viewport } from "~/components/layouts/splash";
import type { SplashState } from "~/model/splash";
import { useQuitGuard } from "~/tui/hooks/use-quit-guard";

export function SplashView({
  workspace,
  state,
  onEnter,
  onClose,
}: {
  readonly workspace: string;
  readonly state: SplashState;
  readonly onEnter: () => void;
  readonly onClose: () => void;
}) {
  const terminal = useTerminalDimensions();
  const [measured, setMeasured] = useState<Viewport>();
  const viewport = measured ?? terminal;
  const quit = useQuitGuard(onClose);
  const { quitting } = quit;
  const enter = useCallback(() => {
    if (state.status === "ready" && !quitting) {
      onEnter();
    }
  }, [onEnter, quitting, state.status]);
  useKeyboard((key) => {
    if (quit.handleKey(key)) {
      return;
    }
    if (key.name === "q") {
      quit.ask();
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      enter();
    }
  });
  return (
    <SplashLayout
      card={
        <SplashCard
          height={viewport.height}
          onEnter={enter}
          state={state}
          width={viewport.width}
          workspace={workspace}
        />
      }
      height={viewport.height}
      onResize={setMeasured}
      overlay={
        quitting && <QuitDialog onCancel={quit.cancel} onConfirm={onClose} />
      }
      paused={quitting}
      width={viewport.width}
    />
  );
}
