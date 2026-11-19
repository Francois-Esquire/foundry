import { Hint } from "@/components/blocks/hint";
import { ListRow } from "@/components/blocks/list-row";
import { Spinner } from "@/components/blocks/spinner";
import { useTheme } from "@/hooks/use-theme";
import type { Status, Thread } from "@/model/thread";

const ICONS: Record<Exclude<Status, "running">, string> = {
  error: "✗",
  pending: "○",
  success: "✓",
};

export function TodoList({ thread }: { readonly thread: Thread }) {
  const theme = useTheme();
  const colors: Record<Status, string> = {
    error: theme.colors.error,
    pending: theme.colors.mutedForeground,
    running: theme.colors.primary,
    success: theme.colors.success,
  };
  if (thread.phase === "planning") {
    return (
      <ListRow color={theme.colors.primary} icon={<Spinner />}>
        Planning the goal into to-dos
      </ListRow>
    );
  }
  if (thread.todos.length === 0) {
    return <Hint>No to-dos yet. A goal is planned into two to four.</Hint>;
  }
  return (
    <>
      {thread.todos.map((todo) => (
        <ListRow
          color={colors[todo.status]}
          icon={todo.status === "running" ? <Spinner /> : ICONS[todo.status]}
          key={todo.id}
          note={todo.added ? "added by the worker" : undefined}
        >
          {todo.title}
        </ListRow>
      ))}
    </>
  );
}
