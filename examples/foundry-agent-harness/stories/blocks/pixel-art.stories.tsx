import { defineStories, story } from "textbook-sh";
import { PixelArt } from "@/components/blocks/pixel-art";
import { grain } from "@/model/grain";
import { hud, tones } from "@/model/palette";
import { createCanvas, etch, fill, rasterize, stamp } from "@/model/pixels";
import { renderFrame } from "../frame";

const size = { height: 6, width: 24 };

export default defineStories({
  component: "PixelArt",
  description:
    "Rows of coloured runs drawn as half blocks, two pixels to a cell, with text and fine marks on top.",
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
