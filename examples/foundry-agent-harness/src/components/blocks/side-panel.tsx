import { NoteList } from "@/components/blocks/note-list";
import { ServerList } from "@/components/blocks/server-list";
import { SkillList } from "@/components/blocks/skill-list";
import { TodoList } from "@/components/blocks/todo-list";
import { Tabs } from "@/components/ui/tabs";
import type { Context } from "@/model/context";
import type { Thread } from "@/model/thread";
import { finishedTodos } from "@/model/thread";

export function SidePanel({
  context,
  thread,
}: {
  readonly context: Context;
  readonly thread: Thread;
}) {
  return (
    <Tabs
      borderStyle="rounded"
      tabBarPaddingX={1}
      tabs={[
        {
          content: <TodoList thread={thread} />,
          key: "todos",
          label: `To-dos ${finishedTodos(thread)}/${thread.todos.length}`,
        },
        {
          content: <NoteList notes={thread.notes} />,
          key: "notes",
          label: "Notes",
        },
        {
          content: <SkillList skills={context.skills} />,
          key: "skills",
          label: `Skills ${context.skills.length}`,
        },
        {
          content: <ServerList servers={context.servers} />,
          key: "mcp",
          label: `MCP ${context.servers.length}`,
        },
      ]}
    />
  );
}
