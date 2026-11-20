import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback, useMemo } from "react";
import { HudFrame } from "@/components/blocks/hud-frame";
import type { RailSectionSpec } from "@/model/hud";
import { frameRows, hudGeometry, railPlan } from "@/model/hud";
import type { Size } from "@/model/screen";

const HUD_RAIL_WIDTH = 28;

export interface HudSection extends RailSectionSpec {
  readonly content: ReactNode;
}

export function HudLayout({
  goal,
  main,
  onResize,
  sections,
  size,
  title,
}: {
  readonly goal: ReactNode;
  readonly main: ReactNode;
  readonly onResize: (size: Size) => void;
  readonly sections: readonly HudSection[];
  readonly size: Size;
  readonly title: string;
}) {
  const geometry = hudGeometry(size, HUD_RAIL_WIDTH);
  const plan = useMemo(
    () => railPlan(sections, size.height),
    [sections, size.height]
  );
  const rows = useMemo(
    () =>
      frameRows({
        goalRow: geometry.goalRow,
        rail: HUD_RAIL_WIDTH,
        rules: plan.rules,
        size,
        title,
      }),
    [geometry.goalRow, plan.rules, size, title]
  );
  const measure = useCallback(
    function measureHud(this: BoxRenderable) {
      onResize({ height: this.height, width: this.width });
    },
    [onResize]
  );
  return (
    <box height="100%" onSizeChange={measure} width="100%">
      <HudFrame rows={rows} />
      {sections.map((section, index) => {
        const slot = plan.slots[index];
        return slot && slot.height > 0 ? (
          <box
            flexDirection="column"
            height={slot.height}
            key={section.key}
            left={1}
            overflow="hidden"
            paddingX={1}
            position="absolute"
            top={slot.top}
            width={geometry.railInner}
          >
            {section.content}
          </box>
        ) : null;
      })}
      <box
        flexDirection="column"
        height={geometry.mainHeight}
        left={geometry.mainLeft}
        overflow="hidden"
        paddingX={1}
        position="absolute"
        top={1}
        width={geometry.mainWidth}
      >
        {main}
      </box>
      <box
        flexDirection="row"
        height={1}
        left={geometry.mainLeft}
        paddingX={1}
        position="absolute"
        top={geometry.goalTop}
        width={geometry.mainWidth}
      >
        {goal}
      </box>
    </box>
  );
}
