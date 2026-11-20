import { defineStories, story } from "textbook-sh";
import { SidePanel } from "@/components/blocks/side-panel";
import { context, threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 16, padded: false, width: 42 };

export default defineStories({
  component: "SidePanel",
  description:
    "The tabbed panel: to-dos, notes, skills, and MCP. Tab moves through it.",
  title: "Blocks/SidePanel",
});

export const Empty = story({
  description: "A new thread.",
  name: "Empty",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SidePanel context={context} thread={threads.idle} />,
      size
    ),
});

export const Working = story({
  description: "A goal in progress.",
  name: "Working",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SidePanel context={context} thread={threads.working} />,
      size
    ),
});

export const Done = story({
  description: "A finished goal with notes kept.",
  name: "Done",
  render: (renderer) =>
    renderFrame(
      renderer,
      <SidePanel context={context} thread={threads.done} />,
      size
    ),
});
