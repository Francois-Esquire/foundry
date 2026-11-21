import type { ReactNode } from "react";
import { NoteList } from "@/components/blocks/note-list";
import { ServerList } from "@/components/blocks/server-list";
import { SkillList } from "@/components/blocks/skill-list";
import { TodoList } from "@/components/blocks/todo-list";
import { Tabs } from "@/components/ui/tabs";
import type { Context } from "@/model/context";
import type { Thread } from "@/model/thread";
import { finishedTodos } from "@/model/thread";

export const SIDE_TABS = ["todos", "notes", "skills", "mcp"] as const;

export type SideTab = (typeof SIDE_TABS)[number];

export function SidePanel({
  active,
  context,
  frame,
  thread,
}: {
  readonly active: SideTab;
  readonly context: Context;
  readonly frame: number;
  readonly thread: Thread;
}) {
  const panes: Record<SideTab, { content: ReactNode; label: string }> = {
    mcp: {
      content: <ServerList servers={context.servers} />,
      label: `MCP ${context.servers.length}`,
    },
    notes: { content: <NoteList notes={thread.notes} />, label: "Notes" },
    skills: {
      content: <SkillList skills={context.skills} />,
      label: `Skills ${context.skills.length}`,
    },
    todos: {
      content: <TodoList frame={frame} thread={thread} />,
      label: `To-dos ${finishedTodos(thread)}/${thread.todos.length}`,
    },
  };
  return (
    <Tabs
      activeTab={active}
      borderStyle="rounded"
      tabBarPaddingX={1}
      tabs={SIDE_TABS.map((key) => ({ key, ...panes[key] }))}
    />
  );
}
