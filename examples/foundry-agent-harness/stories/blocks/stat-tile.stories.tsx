import { defineStories, story } from "textbook-sh";
import { StatTile } from "@/components/blocks/stat-tile";
import { renderFrame } from "../frame";

const size = { height: 5, width: 24 };

export default defineStories({
  component: "StatTile",
  description:
    "A percentage in tall pixel numerals beside a caption, a note, and a gauge.",
  title: "Blocks/StatTile",
});

export const Amber = story({
  description: "Two digits in amber, with a note.",
  name: "Amber",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatTile
        label="CONTEXT"
        level={0.71}
        note="of 200k"
        tone="amber"
        width={22}
      />,
      size
    ),
});

export const Low = story({
  description: "One digit in red.",
  name: "Low",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatTile label="STAMINA" level={0.08} tone="red" width={22} />,
      size
    ),
});

export const Full = story({
  description: "Three digits take the room of the percent sign.",
  name: "Full",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatTile label="STAMINA" level={1} tone="green" width={22} />,
      size
    ),
});

export const Coarse = story({
  description: "The half-block tier, with its blockier numerals.",
  name: "Coarse",
  render: (renderer) =>
    renderFrame(
      renderer,
      <StatTile
        detail="coarse"
        label="CONTEXT"
        level={0.71}
        note="of 200k"
        tone="amber"
        width={22}
      />,
      size
    ),
});
