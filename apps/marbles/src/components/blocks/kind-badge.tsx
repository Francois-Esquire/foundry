import { theme } from "~/components/ui/theme";
import type { ItemKind } from "~/views/dashboard-model";

export function KindBadge({ kind }: { readonly kind: ItemKind }) {
  // Read as it renders: `applyTheme` swaps the palette after this loads.
  const colors: Readonly<Record<ItemKind, string>> = {
    monitor: theme.colors.warning,
    schedule: theme.colors.info,
    step: theme.colors.secondary,
    workflow: theme.colors.primary,
  };
  return <text fg={colors[kind]}>{`[${kind}]`}</text>;
}
