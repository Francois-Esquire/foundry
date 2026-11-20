import { defineStories, story } from "textbook-sh";
import type { SideTab } from "@/components/blocks/side-panel";
import { HarnessLayout } from "@/components/layouts/harness";
import type { Size } from "@/model/screen";
import type { Thread } from "@/model/thread";
import { clock, context, threads } from "../fixtures/threads";
import { ignore, renderFrame } from "../frame";

const wide = { height: 30, width: 120 };
const narrow = { height: 24, width: 64 };

export default defineStories({
  component: "HarnessLayout",
  description: "The whole screen as a function of its props.",
  title: "Layouts/Harness",
});

function screen(
  thread: Thread,
  {
    activeTab = "todos",
    draft = "",
    size = wide,
  }: {
    readonly activeTab?: SideTab;
    readonly draft?: string;
    readonly size?: Size;
  } = {}
) {
  return (
    <HarnessLayout
      activeTab={activeTab}
      clock={clock}
      context={context}
      draft={draft}
      onDraft={ignore}
      onResize={ignore}
      onSubmit={ignore}
      size={size}
      thread={thread}
    />
  );
}

function render(node: ReturnType<typeof screen>, size: Size = wide) {
  return (renderer: Parameters<typeof renderFrame>[0]) =>
    renderFrame(renderer, node, { ...size, padded: false });
}

export const Idle = story({
  description: "A new thread waiting for a goal.",
  name: "Idle",
  render: render(screen(threads.idle)),
});

export const Drafted = story({
  description: "A goal typed and not yet handed over.",
  name: "Drafted",
  render: render(
    screen(threads.idle, {
      draft: "List the source files here and say what each one is for.",
    })
  ),
});

export const Planning = story({
  description: "The goal is being planned.",
  name: "Planning",
  render: render(screen(threads.planning)),
});

export const Working = story({
  description: "To-dos in progress with a tool call running.",
  name: "Working",
  render: render(screen(threads.working)),
});

export const Done = story({
  description: "A finished goal.",
  name: "Done",
  render: render(screen(threads.done)),
});

export const Failed = story({
  description: "A turn failed and the rest were cancelled.",
  name: "Failed",
  render: render(screen(threads.failed)),
});

export const NotesTab = story({
  description: "The notes tab of a finished goal.",
  name: "Notes tab",
  render: render(screen(threads.done, { activeTab: "notes" })),
});

export const SkillsTab = story({
  description: "The skills tab.",
  name: "Skills tab",
  render: render(screen(threads.done, { activeTab: "skills" })),
});

export const ServersTab = story({
  description: "The MCP tab.",
  name: "MCP tab",
  render: render(screen(threads.done, { activeTab: "mcp" })),
});

export const Narrow = story({
  description: "Under 72 columns the panel is dropped.",
  name: "Narrow",
  render: render(screen(threads.done, { size: narrow }), narrow),
});
