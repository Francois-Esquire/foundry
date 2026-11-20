import { Tag } from "~/components/ui/tag";
import { theme } from "~/components/ui/theme";

export interface CostView {
  readonly priced: boolean;
  readonly value: string;
}

export function CostTag({ cost }: { readonly cost: CostView }) {
  if (cost.priced) {
    return <Tag color={theme.colors.accent}>{cost.value}</Tag>;
  }
  return (
    <text fg={theme.colors.mutedForeground} flexShrink={0} wrapMode="none">
      {cost.value}
    </text>
  );
}
