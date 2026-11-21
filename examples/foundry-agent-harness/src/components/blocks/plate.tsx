import type { ReactNode } from "react";
import { BRACKETED, hud } from "@/model/palette";

export function Plate({
  children,
  grow = false,
  icon,
  meta,
  title,
  tone = hud.bronze,
}: {
  readonly children: ReactNode;
  readonly grow?: boolean;
  readonly icon?: string;
  readonly meta?: string;
  readonly title?: string;
  readonly tone?: string;
}) {
  return (
    <box
      border
      borderColor={tone}
      customBorderChars={BRACKETED}
      flexDirection="column"
      flexGrow={grow ? 1 : 0}
      flexShrink={grow ? 1 : 0}
      overflow="hidden"
    >
      {title === undefined ? null : (
        <box
          backgroundColor={hud.tint}
          flexDirection="row"
          flexShrink={0}
          gap={1}
          height={1}
          paddingX={1}
        >
          <text fg={hud.amber} flexShrink={0} wrapMode="none">
            {`${icon ?? "▚"}  `}
            <b>{title}</b>
          </text>
          <box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
            <text fg={hud.faint} wrapMode="none">
              {"╌".repeat(60)}
            </text>
          </box>
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
