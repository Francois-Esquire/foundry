import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback } from "react";
import { Plate } from "@/components/blocks/plate";
import { hud } from "@/model/palette";
import type { Size } from "@/model/screen";

const RAIL_WIDTH = 30;

export interface HudSection {
  readonly content: ReactNode;
  readonly grow?: boolean;
  readonly key: string;
  readonly meta?: string;
  readonly title?: string;
}

export function HudLayout({
  goal,
  hints,
  main,
  onResize,
  sections,
  steps,
}: {
  readonly goal: ReactNode;
  readonly hints: ReactNode;
  readonly main: ReactNode;
  readonly onResize: (size: Size) => void;
  readonly sections: readonly HudSection[];
  readonly steps: ReactNode;
}) {
  const measure = useCallback(
    function measureHud(this: BoxRenderable) {
      onResize({ height: this.height, width: this.width });
    },
    [onResize]
  );
  return (
    <box
      backgroundColor={hud.ink}
      flexDirection="column"
      height="100%"
      onSizeChange={measure}
      width="100%"
    >
      <box flexDirection="row" flexGrow={1} flexShrink={1} gap={1}>
        <box flexDirection="column" flexShrink={0} width={RAIL_WIDTH}>
          {sections.map((section) => (
            <Plate
              grow={section.grow}
              key={section.key}
              meta={section.meta}
              title={section.title}
            >
              {section.content}
            </Plate>
          ))}
        </box>
        <box flexDirection="column" flexGrow={1} flexShrink={1}>
          <box flexShrink={0} height={1} paddingX={1}>
            {steps}
          </box>
          <Plate grow>{main}</Plate>
          <Plate tone={hud.amber}>{goal}</Plate>
        </box>
      </box>
      <box flexShrink={0} height={1} paddingX={1}>
        {hints}
      </box>
    </box>
  );
}
