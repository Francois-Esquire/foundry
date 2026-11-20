import { defineStories, story } from "textbook-sh";
import { SparkleField } from "~/components/ui/sparkle-field";
import { renderFrame } from "./frame";

export default defineStories({
  component: "SparkleField",
  description: "The shimmering sparkles behind the splash card.",
  title: "UI/SparkleField",
});

export const Full = story({
  description: "A large field with diamond sparkles, shimmering.",
  name: "Full",
  render: (renderer) =>
    renderFrame(renderer, <SparkleField height={28} width={90} />, {
      height: 28,
      padded: false,
      width: 90,
    }),
});

export const Compact = story({
  description: "Below 90 columns or 28 rows the diamonds become crosses.",
  name: "Compact",
  render: (renderer) =>
    renderFrame(renderer, <SparkleField height={24} width={80} />, {
      height: 24,
      padded: false,
      width: 80,
    }),
});

export const Paused = story({
  description: "A paused field holds its first frame.",
  name: "Paused",
  render: (renderer) =>
    renderFrame(renderer, <SparkleField height={28} paused width={90} />, {
      height: 28,
      padded: false,
      width: 90,
    }),
});
