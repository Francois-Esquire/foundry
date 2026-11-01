import { theme } from "~/components/ui/theme";
import {
  type InputAttention,
  type StatusTone,
  statusDisplay,
} from "~/model/run-status";

/** A status in its tone, or the attention a person owes it. */
export function StatusLabel({
  item,
}: {
  readonly item: {
    readonly attention?: InputAttention;
    readonly status: string;
  };
}) {
  const { label, tone } = statusDisplay(item);
  // Read as it renders: `applyTheme` swaps the palette after this loads.
  const colors: Readonly<Record<StatusTone, string>> = {
    error: theme.colors.error,
    info: theme.colors.info,
    neutral: theme.colors.mutedForeground,
    success: theme.colors.success,
    warning: theme.colors.warning,
  };
  return <text fg={colors[tone]}>{label}</text>;
}
