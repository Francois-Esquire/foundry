import { theme } from "~/components/ui/theme";
import {
  type InputAttention,
  type StatusTone,
  statusDisplay,
} from "~/views/run-status";

const TONE_COLORS: Readonly<Record<StatusTone, string>> = {
  error: theme.colors.error,
  info: theme.colors.info,
  neutral: theme.colors.mutedForeground,
  success: theme.colors.success,
  warning: theme.colors.warning,
};

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
  return <text fg={TONE_COLORS[tone]}>{label}</text>;
}
