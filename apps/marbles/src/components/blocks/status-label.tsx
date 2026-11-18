import { theme } from "~/components/ui/theme";
import {
  type InputAttention,
  type StatusTone,
  statusDisplay,
} from "~/model/run-status";

export function StatusLabel({
  item,
}: {
  readonly item: {
    readonly attention?: InputAttention;
    readonly status: string;
  };
}) {
  const { label, tone } = statusDisplay(item);
  const colors: Readonly<Record<StatusTone, string>> = {
    error: theme.colors.error,
    info: theme.colors.info,
    neutral: theme.colors.mutedForeground,
    success: theme.colors.success,
    warning: theme.colors.warning,
  };
  return <text fg={colors[tone]}>{label}</text>;
}
