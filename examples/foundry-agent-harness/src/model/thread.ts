import type { Weapon } from "@/model/context";

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
  context: number;
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
  show: (thread: Thread) => void,
  weapon: Weapon
) => Promise<void>;

export const emptyThread: Thread = {
  context: 0,
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

export interface Tally {
  readonly count: number;
  readonly failed: number;
  readonly name: string;
  readonly running: boolean;
}

export function toolTallies(thread: Thread): Tally[] {
  const tallies = new Map<string, Tally>();
  for (const message of thread.messages) {
    for (const tool of message.tools) {
      const kept = tallies.get(tool.name);
      tallies.set(tool.name, {
        count: (kept?.count ?? 0) + 1,
        failed: (kept?.failed ?? 0) + (tool.status === "error" ? 1 : 0),
        name: tool.name,
        running: (kept?.running ?? false) || tool.status === "running",
      });
    }
  }
  return [...tallies.values()].sort((a, b) => b.count - a.count);
}

export function contextUsed(thread: Thread, limit: number): number {
  return limit > 0 ? Math.min(Math.max(thread.context / limit, 0), 1) : 0;
}

export function hasFailed(thread: Thread): boolean {
  return thread.messages.at(-1)?.kind === "error";
}

export function compactCount(count: number): string {
  return count < 1000
    ? String(count)
    : `${(count / 1000).toFixed(1).replace(".0", "")}k`;
}
