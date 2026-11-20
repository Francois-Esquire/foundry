import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback } from "react";
import { Plate } from "@/components/blocks/plate";
import { hud } from "@/model/palette";
import type { Size } from "@/model/screen";

const RAIL_WIDTH = 28;

export interface HudSection {
  readonly content: ReactNode;
  readonly grow?: boolean;
  readonly key: string;
  readonly meta?: string;
  readonly title?: string;
}

export function HudLayout({
  goal,
  main,
  meta,
  onResize,
  sections,
  title,
}: {
  readonly goal: ReactNode;
  readonly main: ReactNode;
  readonly meta?: string;
  readonly onResize: (size: Size) => void;
  readonly sections: readonly HudSection[];
  readonly title: string;
}) {
  const measure = useCallback(
    function measureHud(this: BoxRenderable) {
      onResize({ height: this.height, width: this.width });
    },
    [onResize]
  );
  return (
    <box
      backgroundColor={hud.gutter}
      flexDirection="row"
      gap={1}
      height="100%"
      onSizeChange={measure}
      width="100%"
    >
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
      <box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
        <Plate grow meta={meta} screen title={title}>
          {main}
        </Plate>
        <Plate>{goal}</Plate>
      </box>
    </box>
  );
}
