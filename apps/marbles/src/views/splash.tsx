import type { BoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useState } from "react";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { SplashCard } from "~/components/blocks/splash-card";
import { SparkleField } from "~/components/ui/sparkle-field";
import { theme } from "~/components/ui/theme";
import { useQuitGuard } from "~/hooks/use-quit-guard";
import type { SplashState } from "~/model/splash";

export function SplashView({
  workspace,
  state,
  preview,
  onEnter,
  onClose,
}: {
  readonly workspace: string;
  readonly state: SplashState;
  readonly preview: boolean;
  readonly onEnter: () => void;
  readonly onClose: () => void;
}) {
  const terminal = useTerminalDimensions();
  const [viewport, setViewport] = useState<typeof terminal>();
  const { height, width } = viewport ?? terminal;
  const measure = useCallback(function measureSplash(this: BoxRenderable) {
    setViewport({ height: this.height, width: this.width });
  }, []);
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
    <box
      alignItems="center"
      backgroundColor={theme.colors.background}
      height="100%"
      justifyContent="center"
      onSizeChange={measure}
      width="100%"
    >
      <SparkleField height={height} paused={quitting} width={width} />
      <SplashCard
        height={height}
        onEnter={enter}
        preview={preview}
        state={state}
        width={width}
        workspace={workspace}
      />
      {quitting && (
        <QuitDialog
          onCancel={quit.cancel}
          onConfirm={onClose}
          preview={preview}
        />
      )}
    </box>
  );
}
