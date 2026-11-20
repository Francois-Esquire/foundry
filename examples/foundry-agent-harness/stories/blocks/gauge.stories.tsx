import { defineStories, story } from "textbook-sh";
import { Gauge } from "@/components/blocks/gauge";
import { renderFrame } from "../frame";

const size = { height: 3, width: 28 };

export default defineStories({
  component: "Gauge",
  description: "A row of lamp segments, lit up to a level, with a bright tip.",
  title: "Blocks/Gauge",
});

export const Empty = story({
  description: "No segment lit.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(renderer, <Gauge cells={24} level={0} tone="amber" />, size),
});

export const Partial = story({
  description: "Lit part of the way.",
  name: "Partial",
  render: (renderer) =>
    renderFrame(renderer, <Gauge cells={24} level={0.64} tone="red" />, size),
});

export const Full = story({
  description: "Every segment lit.",
  name: "Full",
  render: (renderer) =>
    renderFrame(renderer, <Gauge cells={24} level={1} tone="green" />, size),
});
