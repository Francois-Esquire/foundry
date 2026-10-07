import { theme } from "~/components/ui/theme";
import type { ItemKind } from "~/views/dashboard-model";

const KIND_COLORS: Readonly<Record<ItemKind, string>> = {
  monitor: theme.colors.warning,
  schedule: theme.colors.info,
  step: theme.colors.secondary,
  workflow: theme.colors.primary,
};

export function KindBadge({ kind }: { readonly kind: ItemKind }) {
  return <text fg={KIND_COLORS[kind]}>{`[${kind}]`}</text>;
}
