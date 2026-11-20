import { defineStories, story } from "textbook-sh";
import { PortraitBay } from "@/components/blocks/portrait-bay";
import { renderFrame } from "../frame";

export default defineStories({
  component: "PortraitBay",
  description:
    "A viewport with a placeholder figure between two louvres, and a one-line comment under it.",
  title: "Blocks/PortraitBay",
});

export const Tall = story({
  description: "Eleven rows.",
  name: "Tall",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PortraitBay caption="holding steady" rows={11} width={24} />,
      { height: 13, width: 26 }
    ),
});

export const Short = story({
  description: "Seven rows.",
  name: "Short",
  render: (renderer) =>
    renderFrame(
      renderer,
      <PortraitBay caption="running hot" rows={7} width={24} />,
      { height: 9, width: 26 }
    ),
});
