import type { ReactNode } from "react";
import { hud } from "@/model/palette";
import type { PortraitSize } from "@/model/sprite";

export function PortraitBay({
  focused,
  portrait,
  quip,
  size,
}: {
  readonly focused: boolean;
  readonly portrait: ReactNode;
  readonly quip: string;
  readonly size: PortraitSize;
}) {
  if (size === "small") {
    return (
      <box flexDirection="row" gap={1}>
        {portrait}
        <box flexDirection="column" flexShrink={1} justifyContent="center">
          <text fg={hud.bright}>{`❝ ${quip} ❞`}</text>
          {focused ? <text fg={hud.dim}>↑/↓ change avatar</text> : null}
        </box>
      </box>
    );
  }
  return (
    <box flexDirection="column">
      {portrait}
      <box
        backgroundColor={hud.tint}
        flexDirection="row"
        height={1}
        justifyContent="center"
      >
        <text fg={hud.bright} wrapMode="none">
          {focused ? `◂ ❝ ${quip} ❞ ▸` : `❝ ${quip} ❞`}
        </text>
      </box>
    </box>
  );
}
