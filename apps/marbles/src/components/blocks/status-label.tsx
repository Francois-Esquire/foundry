import { Badge } from "~/components/ui/badge";
import { theme } from "~/components/ui/theme";
import { type InputAttention, statusDisplay } from "~/model/run-status";

export function StatusLabel({
  item,
}: {
  readonly item: {
    readonly attention?: InputAttention;
    readonly status: string;
  };
}) {
  const { label, tone } = statusDisplay(item);
  if (tone === "error" || tone === "warning") {
    return <Badge variant={tone}>{label}</Badge>;
  }
  const colors = {
    info: theme.colors.info,
    neutral: theme.colors.mutedForeground,
    success: theme.colors.success,
  };
  return <text fg={colors[tone]}>{label}</text>;
}
