import { Tag } from "~/components/ui/tag";
import { theme } from "~/components/ui/theme";
import type { ItemKind } from "~/views/dashboard-model";

export function KindBadge({ kind }: { readonly kind: ItemKind }) {
  const colors: Readonly<Record<ItemKind, string>> = {
    monitor: theme.colors.warning,
    schedule: theme.colors.info,
    step: theme.colors.secondary,
    workflow: theme.colors.primary,
  };
  return <Tag color={colors[kind]}>{kind}</Tag>;
}
