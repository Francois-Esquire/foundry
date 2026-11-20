export type Status = "pending" | "running" | "success" | "error";

export interface Todo {
  added: boolean;
  id: string;
  status: Status;
  title: string;
}

export interface ToolUse {
  detail: string;
  error?: string;
  id: string;
  name: string;
  startedAt: number;
  status: Status;
}

export interface Message {
  kind: "goal" | "task" | "error";
  streaming: boolean;
  text: string;
  title: string;
  tools: ToolUse[];
}

export interface Notes {
  files: { path: string; title: string }[];
  version: string;
  versions: number;
}

export interface Thread {
  id: string;
  input: number;
  messages: Message[];
  notes?: Notes;
  output: number;
  phase: "idle" | "planning" | "working";
  title: string;
  todos: Todo[];
}

export type Run = (
  goal: string,
  show: (thread: Thread) => void
) => Promise<void>;

export const emptyThread: Thread = {
  id: "thread-1",
  input: 0,
  messages: [],
  output: 0,
  phase: "idle",
  title: "New thread",
  todos: [],
};

export function isBusy(thread: Thread): boolean {
  return thread.phase !== "idle";
}

export function finishedTodos(thread: Thread): number {
  return thread.todos.filter((todo) => todo.status === "success").length;
}

export function isAnimating(thread: Thread): boolean {
  return (
    isBusy(thread) ||
    thread.todos.some((todo) => todo.status === "running") ||
    thread.messages.some((message) =>
      message.tools.some((tool) => tool.status === "running")
    )
  );
}
