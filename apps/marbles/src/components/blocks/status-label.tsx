import { Badge } from "~/components/ui/badge";
import { theme } from "~/components/ui/theme";
import type { StatusTone } from "~/model/run-status";

export interface StatusView {
  readonly label: string;
  readonly tone: StatusTone;
}

export function StatusLabel({ status }: { readonly status: StatusView }) {
  const { label, tone } = status;
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
