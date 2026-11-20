import { StartupSummary } from "~/components/blocks/startup-summary";
import { Action } from "~/components/ui/action";
import { LoadingIndicator } from "~/components/ui/loading-indicator";
import { theme } from "~/components/ui/theme";
import type { SplashState } from "~/model/splash";

const CARD_CHROME = 6;
const CARD_WIDTH = 65 + CARD_CHROME + 2;
const CARD_MARGIN = 4;

export function SplashCard({
  height,
  onEnter,
  state,
  width,
  workspace,
}: {
  readonly height: number;
  readonly onEnter: () => void;
  readonly state: SplashState;
  readonly width: number;
  readonly workspace: string;
}) {
  const compact = height < 26;
  return (
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
      width={Math.min(CARD_WIDTH, Math.max(1, width - CARD_MARGIN))}
      zIndex={1}
    >
      <ascii-font
        color={[
          theme.colors.primary,
          theme.colors.warning,
          theme.colors.accent,
        ]}
        font={
          width < CARD_WIDTH + CARD_MARGIN || height < 20 ? "tiny" : "block"
        }
        id="splash:logo"
        selectable={false}
        text="MARBLES"
      />
      <text fg={theme.colors.mutedForeground} wrapMode="none">
        {workspace} · workspace
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
          onAction={onEnter}
          value="enter"
        />
      ) : (
        <text fg={theme.colors.mutedForeground}>Please wait...</text>
      )}
      <text fg={theme.colors.mutedForeground}>
        {state.status === "ready" ? "Enter or click · q quit" : "q quit"}
      </text>
    </box>
  );
}
