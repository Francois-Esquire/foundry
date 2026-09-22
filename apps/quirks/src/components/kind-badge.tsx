import type { ItemKind } from "~/views/dashboard-model";
import { Badge } from "./ui/badge";

const variants = {
  monitor: "warning",
  schedule: "info",
  step: "secondary",
  workflow: "default",
} as const;

export function KindBadge({ kind }: { readonly kind: ItemKind }) {
  return <Badge bordered={false} variant={variants[kind]}>{`[${kind}]`}</Badge>;
}
