import type { ReactNode } from "react";
import { Hint } from "@/components/blocks/hint";

export function ListRow({
  children,
  color,
  icon,
  note,
}: {
  readonly children: string;
  readonly color: string;
  readonly icon: ReactNode;
  readonly note?: string;
}) {
  return (
    <box flexDirection="row" gap={1}>
      {typeof icon === "string" ? <text fg={color}>{icon}</text> : icon}
      <box flexDirection="column" flexShrink={1}>
        <text fg={color}>{children}</text>
        {note ? <Hint>{note}</Hint> : null}
      </box>
    </box>
  );
}
