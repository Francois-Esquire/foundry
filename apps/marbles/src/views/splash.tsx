import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback } from "react";
import { QuitDialog } from "~/components/blocks/quit-dialog";
import { StartupSummary } from "~/components/blocks/startup-summary";
import { Action } from "~/components/ui/action";
import { LoadingIndicator } from "~/components/ui/loading-indicator";
import { SparkleField } from "~/components/ui/sparkle-field";
import { theme } from "~/components/ui/theme";
import { useQuitGuard } from "~/hooks/use-quit-guard";
import type { SplashState } from "./splash-model";

/** Card border plus its horizontal padding, both sides. */
const CARD_CHROME = 6;
/** The block logo is 65 columns; the card leaves it one clear column a side. */
const CARD_WIDTH = 65 + CARD_CHROME + 2;
/** The card keeps two columns of terminal on each side. */
const CARD_MARGIN = 4;

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
  const dimensions = useTerminalDimensions();
  const compact = dimensions.height < 26;
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
      width="100%"
    >
      <SparkleField
        height={dimensions.height}
        paused={quitting}
        width={dimensions.width}
      />
      <box
        alignItems="center"
        backgroundColor={theme.colors.background}
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
        width={Math.min(
          CARD_WIDTH,
          Math.max(1, dimensions.width - CARD_MARGIN)
        )}
        zIndex={1}
      >
        <ascii-font
          color={[
            theme.colors.primary,
            theme.colors.warning,
            theme.colors.accent,
          ]}
          font={
            dimensions.width < CARD_WIDTH + CARD_MARGIN ||
            dimensions.height < 20
              ? "tiny"
              : "block"
          }
          id="splash:logo"
          selectable={false}
          text="MARBLES"
        />
        <text fg={theme.colors.mutedForeground} wrapMode="none">
          {workspace} · {preview ? "module preview" : "workspace"}
        </text>
        {state.status === "loading" ? (
          <LoadingIndicator label="Loading marbles" />
        ) : (
          <text fg={theme.colors.success}>
            {state.hasConfig ? "✓ Marbles loaded" : "No source · setup skipped"}
          </text>
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
          onCancel={quit.cancel}
          onConfirm={onClose}
          preview={preview}
        />
      )}
    </box>
  );
}
