import { useTheme } from "~/hooks/use-theme";
import type { StartupCounts } from "~/views/splash-model";

function countLabel(value: number, label: string): string {
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}

export function StartupSummary({
  counts,
  compact,
}: {
  readonly counts?: StartupCounts;
  readonly compact: boolean;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.colors.foreground}>Triggers</text>
        <text fg={theme.colors.accent}>
          {counts ? `${counts.schedules + counts.monitors} loaded` : "—"}
        </text>
      </box>
      <text fg={theme.colors.mutedForeground}>
        {counts
          ? `${countLabel(counts.schedules, "schedule")} · ${countLabel(counts.monitors, "monitor")}`
          : "Schedules and monitors"}
      </text>
      <box
        flexDirection="row"
        justifyContent="space-between"
        marginTop={compact ? 0 : 1}
      >
        <text fg={theme.colors.foreground}>Marbles</text>
        <text fg={theme.colors.accent}>
          {counts ? `${counts.workflows + counts.steps} loaded` : "—"}
        </text>
      </box>
      <text fg={theme.colors.mutedForeground}>
        {counts
          ? `${countLabel(counts.workflows, "workflow")} · ${countLabel(counts.steps, "step")}`
          : "Workflows and steps"}
      </text>
      <text fg={theme.colors.mutedForeground}>
        {counts
          ? `${countLabel(counts.runs, "run")} available`
          : "Reading configuration..."}
      </text>
    </box>
  );
}
