import { defineStories, story } from "textbook-sh";
import { LoadingIndicator } from "~/components/ui/loading-indicator";
import { renderFrame } from "../frame";

export default defineStories({
  component: "LoadingIndicator",
  description: "An animated spinner beside a label.",
  title: "UI/LoadingIndicator",
});

export const Loading = story({
  description: "The spinner animating beside a short label.",
  name: "Loading",
  render: (renderer) =>
    renderFrame(renderer, <LoadingIndicator label="Loading workspace" />, {
      height: 3,
      width: 40,
    }),
});

export const LongLabel = story({
  description: "A label longer than the width wraps under the spinner.",
  name: "Long label",
  render: (renderer) =>
    renderFrame(
      renderer,
      <LoadingIndicator label="Reading run history and checkpoints for every workspace" />,
      { height: 5, width: 30 }
    ),
});
