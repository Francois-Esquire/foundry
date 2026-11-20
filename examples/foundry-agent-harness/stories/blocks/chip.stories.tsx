import { defineStories, story } from "textbook-sh";
import { Chip } from "@/components/blocks/chip";
import { hud } from "@/model/palette";
import { renderFrame } from "../frame";

const size = { height: 3, width: 16 };

export default defineStories({
  component: "Chip",
  description: "A short label on a coloured cap with half-cell ends.",
  title: "Blocks/Chip",
});

export const Amber = story({
  description: "A speaker tag.",
  name: "Amber",
  render: (renderer) =>
    renderFrame(renderer, <Chip tone="amber">AGENT</Chip>, size),
});

export const Steel = story({
  description: "A key cap on the metal ground.",
  name: "Steel",
  render: (renderer) =>
    renderFrame(
      renderer,
      <Chip ground={hud.grain[1]} tone="steel">
        Tab
      </Chip>,
      size
    ),
});
