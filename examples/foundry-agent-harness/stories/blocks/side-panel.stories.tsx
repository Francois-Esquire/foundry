import { defineStories, story } from "textbook-sh";
import { SidePanel, type SideTab } from "@/components/blocks/side-panel";
import type { Thread } from "@/model/thread";
import { clock, context, threads } from "../fixtures/threads";
import { renderFrame } from "../frame";

const size = { height: 16, padded: false, width: 42 };

export default defineStories({
  component: "SidePanel",
  description:
    "The tabbed panel: to-dos, notes, skills, and MCP. The active tab is a prop.",
  title: "Blocks/SidePanel",
});

function panel(thread: Thread, active: SideTab = "todos") {
  return (
    <SidePanel
      active={active}
      context={context}
      frame={clock.frame}
      thread={thread}
    />
  );
}

export const Empty = story({
  description: "A new thread.",
  name: "Empty",
  render: (renderer) => renderFrame(renderer, panel(threads.idle), size),
});

export const Working = story({
  description: "A goal in progress.",
  name: "Working",
  render: (renderer) => renderFrame(renderer, panel(threads.working), size),
});

export const Done = story({
  description: "A finished goal.",
  name: "Done",
  render: (renderer) => renderFrame(renderer, panel(threads.done), size),
});

export const Notes = story({
  description: "The notes tab after a goal was kept.",
  name: "Notes",
  render: (renderer) =>
    renderFrame(renderer, panel(threads.done, "notes"), size),
});

export const Skills = story({
  description: "The skills tab.",
  name: "Skills",
  render: (renderer) =>
    renderFrame(renderer, panel(threads.done, "skills"), size),
});

export const Servers = story({
  description: "The MCP tab.",
  name: "MCP",
  render: (renderer) => renderFrame(renderer, panel(threads.done, "mcp"), size),
});
