import { defineStories, story } from "textbook-sh";
import { PixelArt } from "@/components/blocks/pixel-art";
import { PortraitBay } from "@/components/blocks/portrait-bay";
import { StatTile } from "@/components/blocks/stat-tile";
import { grain } from "@/model/grain";
import { hud, tones } from "@/model/palette";
import {
  createCanvas,
  createFineCanvas,
  type Detail,
  etch,
  fill,
  rasterize,
  rasterizeFine,
  stamp,
} from "@/model/pixels";
import { sextant } from "@/model/sextants";
import { renderFrame } from "../frame";

const size = { height: 6, width: 24 };

export default defineStories({
  component: "PixelArt",
  description:
    "Rows of coloured runs: half blocks at two pixels a cell or sextants at six, with text on top.",
  title: "Blocks/PixelArt",
});

function sprite() {
  const canvas = createCanvas(8, 3, () => hud.screen);
  stamp(canvas, 1, 1, [" #### ", "#o##o#", "######", " #  # "], {
    "#": tones.amber.lit,
    o: tones.amber.deep,
  });
  return rasterize(canvas);
}

function plate() {
  const canvas = createCanvas(20, 3, grain);
  fill(canvas, { height: 2, width: 12, x: 4, y: 2 }, hud.screen);
  return rasterize(canvas, [
    ...etch(canvas, { width: 20, x: 0, y: 0 }, "▔", hud.iron[6]),
    ...etch(canvas, { width: 12, x: 4, y: 2 }, "▔", hud.iron[6]),
    { bg: hud.screen, fg: hud.amber, text: " engraved ", x: 5, y: 1 },
  ]);
}

export const Pixels = story({
  description: "A sprite stamped onto a canvas, two pixels to a cell.",
  name: "Pixels",
  render: (renderer) =>
    renderFrame(renderer, <PixelArt rows={sprite()} />, size),
});

export const Marked = story({
  description: "A grained plate with etched edge lines and a label.",
  name: "Marked",
  render: (renderer) =>
    renderFrame(renderer, <PixelArt rows={plate()} />, size),
});

const PATTERNS = 64;
const RULER_ROW = 32;

function ruler() {
  const canvas = createFineCanvas(RULER_ROW * 2, 4, hud.screen);
  fill(canvas, { height: 3, width: RULER_ROW * 4, x: 0, y: 9 }, (x, y) =>
    (x + y) % 4 < 2 ? tones.amber.lit : hud.screen
  );
  const glyphs = Array.from({ length: PATTERNS }, (_, pattern) =>
    sextant(pattern)
  );
  return rasterizeFine(
    canvas,
    [0, 1].map((row) => ({
      bg: tones.amber.deep,
      fg: tones.amber.lit,
      text: glyphs.slice(row * RULER_ROW, (row + 1) * RULER_ROW).join(" "),
      x: 0,
      y: row * 2,
    }))
  );
}

function Tier({ detail }: { readonly detail: Detail }) {
  return (
    <box flexDirection="column" gap={1} width={24}>
      <text fg={hud.dim}>{detail}</text>
      <PortraitBay caption="test card" detail={detail} rows={9} width={24} />
      <StatTile
        detail={detail}
        label="LEVEL"
        level={0.64}
        note="of 100"
        tone="amber"
        width={22}
      />
    </box>
  );
}

export const TestCard = story({
  description:
    "The same art in both tiers, then every sextant glyph and a striped field. If the glyphs join without gaps here, the fine tier suits this terminal.",
  name: "Test card",
  render: (renderer) =>
    renderFrame(
      renderer,
      <box flexDirection="column" gap={1}>
        <box flexDirection="row" gap={4}>
          <Tier detail="fine" />
          <Tier detail="coarse" />
        </box>
        <PixelArt rows={ruler()} />
      </box>,
      { height: 24, width: 68 }
    ),
});
