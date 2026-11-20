import type { BoxRenderable } from "@opentui/core";
import { type ReactNode, useCallback, useMemo } from "react";
import { PixelArt } from "@/components/blocks/pixel-art";
import { type HudPart, hudArt, hudGeometry, type Rect } from "@/model/hud-art";
import { fineHudArt } from "@/model/hud-fine";
import type { Detail } from "@/model/pixels";
import type { Size } from "@/model/screen";

export interface HudSection extends HudPart {
  readonly bleed?: boolean;
  readonly content: ReactNode;
  readonly key: string;
}

function Region({
  area,
  children,
}: {
  readonly area: Rect;
  readonly children: ReactNode;
}) {
  return (
    <box
      flexDirection="column"
      height={area.height}
      left={area.x}
      overflow="hidden"
      position="absolute"
      top={area.y}
      width={area.width}
    >
      {children}
    </box>
  );
}

export function HudLayout({
  detail = "fine",
  goal,
  hints,
  main,
  onResize,
  sections,
  size,
  steps,
}: {
  readonly detail?: Detail;
  readonly goal: ReactNode;
  readonly hints: ReactNode;
  readonly main: ReactNode;
  readonly onResize: (size: Size) => void;
  readonly sections: readonly HudSection[];
  readonly size: Size;
  readonly steps: ReactNode;
}) {
  const measure = useCallback(
    function measureHud(this: BoxRenderable) {
      onResize({ height: this.height, width: this.width });
    },
    [onResize]
  );
  const geometry = useMemo(() => hudGeometry(size, sections), [size, sections]);
  const art = useMemo(
    () =>
      detail === "fine" ? fineHudArt(size, sections) : hudArt(size, sections),
    [detail, size, sections]
  );
  return (
    <box height="100%" onSizeChange={measure} width="100%">
      <box left={0} position="absolute" top={0}>
        <PixelArt rows={art} />
      </box>
      {sections.map((section, index) => {
        const frame = geometry.parts[index];
        return frame ? (
          <Region
            area={section.bleed ? frame.inset : frame.body}
            key={section.key}
          >
            {section.content}
          </Region>
        ) : null;
      })}
      <Region area={geometry.steps}>{steps}</Region>
      <Region area={geometry.main}>{main}</Region>
      <Region area={geometry.goal}>{goal}</Region>
      <Region area={geometry.hints}>{hints}</Region>
    </box>
  );
}
