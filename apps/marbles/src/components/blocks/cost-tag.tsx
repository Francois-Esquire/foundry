import { UNPRICED_COST_CELL } from "~/cli/state/usage-format";
import { Tag } from "~/components/ui/tag";
import { theme } from "~/components/ui/theme";

export function CostTag({ value }: { readonly value: string }) {
  if (value !== UNPRICED_COST_CELL) {
    return <Tag color={theme.colors.accent}>{value}</Tag>;
  }
  return (
    <text fg={theme.colors.mutedForeground} flexShrink={0} wrapMode="none">
      {value}
    </text>
  );
}
