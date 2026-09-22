import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useState } from "react";
import { Action } from "~/components/action";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { StartupSummary } from "~/components/blocks/startup-summary";
import { LoadingIndicator } from "~/components/ui/loading-indicator";
import { useTheme } from "~/hooks/use-theme";
import type { SplashState } from "./splash-model";

/** The host owns config loading; this view waits for ready before allowing entry. */
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
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const compact = dimensions.height < 26;
  const [quitting, setQuitting] = useState(false);
  const cancelQuit = useCallback(() => setQuitting(false), []);
  const enter = useCallback(() => {
    if (state.status === "ready" && !quitting) {
      onEnter();
    }
  }, [onEnter, quitting, state.status]);
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (!key.repeated) {
        if (quitting) {
          onClose();
        } else {
          setQuitting(true);
        }
      }
      return;
    }
    if (quitting) {
      return;
    }
    if (key.name === "q") {
      setQuitting(true);
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
      width="100%"
    >
      <box
        alignItems="center"
        border
        borderColor={
          state.status === "ready" ? theme.colors.accent : theme.border.color
        }
        borderStyle="rounded"
        flexDirection="column"
        gap={compact ? 0 : 1}
        id="splash:card"
        paddingX={2}
        paddingY={compact ? 0 : 1}
        width={Math.min(64, Math.max(1, dimensions.width - 4))}
      >
        <ascii-font
          color={[
            theme.colors.primary,
            theme.colors.warning,
            theme.colors.accent,
          ]}
          font={
            dimensions.width < 70 || dimensions.height < 20 ? "tiny" : "block"
          }
          id="splash:logo"
          selectable={false}
          text="QUIRKS"
        />
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          {workspace} · {preview ? "config preview" : "workspace"}
        </text>
        {state.status === "loading" ? (
          <LoadingIndicator label="Loading config" />
        ) : (
          <text fg={theme.colors.success}>✓ Config loaded</text>
        )}
        <StartupSummary
          compact={compact}
          counts={state.status === "ready" ? state.counts : undefined}
        />
        {state.status === "ready" ? (
          <Action
            active
            id="splash:enter"
            label="Press Enter to enter"
            onAction={enter}
            value="enter"
          />
        ) : (
          <text fg={theme.colors.mutedForeground}>Please wait...</text>
        )}
        <text fg={theme.colors.mutedForeground}>
          {state.status === "ready" ? "Enter or click · q quit" : "q quit"}
        </text>
      </box>
      {quitting && (
        <QuitDialog
          onCancel={cancelQuit}
          onConfirm={onClose}
          preview={preview}
        />
      )}
    </box>
  );
}
