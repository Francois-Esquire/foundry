import type { ReactNode } from "react";
import { hud } from "@/model/palette";

export function Plate({
  children,
  grow = false,
  meta,
  title,
  tone = hud.bronze,
}: {
  readonly children: ReactNode;
  readonly grow?: boolean;
  readonly meta?: string;
  readonly title?: string;
  readonly tone?: string;
}) {
  return (
    <box
      border
      borderColor={tone}
      borderStyle="rounded"
      bottomTitle={meta ? ` ${meta} ` : undefined}
      bottomTitleAlignment="right"
      flexDirection="column"
      flexGrow={grow ? 1 : 0}
      flexShrink={grow ? 1 : 0}
      overflow="hidden"
      paddingX={1}
      title={title ? ` ${title} ` : undefined}
      titleColor={hud.amber}
    >
      {children}
    </box>
  );
}
