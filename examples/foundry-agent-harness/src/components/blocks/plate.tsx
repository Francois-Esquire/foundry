import type { ReactNode } from "react";
import { hud } from "@/model/palette";

export function Plate({
  children,
  grow = false,
  meta,
  screen = false,
  title,
}: {
  readonly children: ReactNode;
  readonly grow?: boolean;
  readonly meta?: string;
  readonly screen?: boolean;
  readonly title?: string;
}) {
  return (
    <box
      backgroundColor={screen ? hud.screen : hud.plate}
      flexDirection="column"
      flexGrow={grow ? 1 : 0}
      flexShrink={grow ? 1 : 0}
      overflow="hidden"
    >
      {title === undefined ? null : (
        <box
          backgroundColor={hud.band}
          flexDirection="row"
          flexShrink={0}
          gap={1}
          height={1}
          paddingX={1}
        >
          <text fg={hud.amber} flexShrink={1} truncate wrapMode="none">
            <b>{title}</b>
          </text>
          <box flexGrow={1} />
          {meta ? (
            <text fg={hud.dim} flexShrink={0} wrapMode="none">
              {meta}
            </text>
          ) : null}
        </box>
      )}
      <box flexDirection="column" flexGrow={1} paddingX={1}>
        {children}
      </box>
    </box>
  );
}
