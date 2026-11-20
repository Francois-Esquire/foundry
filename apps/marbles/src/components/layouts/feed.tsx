import type { ReactNode } from "react";

const LIST_SHARE = 0.38;
const MAX_LIST_WIDTH = 52;
const STACK_BELOW = 90;

export function FeedLayout({
  width,
  list,
  reader,
}: {
  readonly width: number;
  readonly list: ReactNode;
  readonly reader: ReactNode;
}) {
  const stacked = width < STACK_BELOW;
  const listWidth = Math.min(MAX_LIST_WIDTH, Math.floor(width * LIST_SHARE));
  return (
    <box
      flexDirection={stacked ? "column" : "row"}
      flexGrow={1}
      gap={stacked ? 0 : 1}
      minHeight={0}
    >
      <box
        flexDirection="column"
        flexShrink={0}
        height={stacked ? "40%" : undefined}
        width={stacked ? "100%" : listWidth}
      >
        {list}
      </box>
      <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
        {reader}
      </box>
    </box>
  );
}
