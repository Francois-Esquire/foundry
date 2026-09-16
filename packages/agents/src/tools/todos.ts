import { EventEmitter } from "node:events";

import { tool } from "ai";
import { z } from "zod";

import { tagTools } from "../harness/types";

export interface TodoItem {
  description: string;
  id: string;
  state: "pending" | "in_progress" | "completed";
}

export interface TodoEventMap {
  /** Fired after every mutation (and on hydrate) with the current list — the
   *  single signal a live consumer needs to re-render. */
  changed: [TodoItem[]];
  "todo.added": [TodoItem];
  "todo.completed": [TodoItem];
  "todo.removed": [TodoItem];
  "todo.reset": [];
  "todo.started": [TodoItem];
}

const TODO_TOOL_DESCRIPTION = `Manage a task list for multi-step work.
WHEN TO USE: tasks with 3+ steps, multiple files, or dependencies between
  changes. Plan once, then track progress as you go.
WHEN NOT TO USE: single-file fixes, simple questions, exploratory reads.
DO NOT USE FOR: status updates to the user (just answer them directly).`;

const todoInputSchema = z.object({
  action: z.enum(["add", "start", "complete", "remove", "list", "reset"]),
  description: z.string().optional(),
  id: z.string().optional(),
});

export class TodoStore extends EventEmitter<TodoEventMap> {
  readonly #todos: TodoItem[] = [];

  constructor(todos: TodoItem[] = []) {
    super();
    this.#todos = todos;
  }

  get items(): readonly TodoItem[] {
    return this.#todos;
  }

  /** Replace the whole list (e.g. loading a session's persisted todos), then
   *  signal `changed` so any live consumer pointed at this store refreshes. */
  hydrate(items: TodoItem[]): void {
    this.#todos.length = 0;
    this.#todos.push(...items);
    this.#changed();
  }

  add(description: string): TodoItem {
    const item: TodoItem = {
      description: description || "(unnamed)",
      id: crypto.randomUUID().slice(0, 8),
      state: "pending",
    };
    this.#todos.push(item);
    this.emit("todo.added", item);
    this.#changed();
    return item;
  }

  start(id: string): string {
    const active = this.#todos.find((t) => t.state === "in_progress");
    if (active) {
      return `Already working on: [${active.id}] ${active.description}. Complete it first.`;
    }
    const next = this.#todos.find((t) => t.id === id);
    if (next) {
      next.state = "in_progress";
      this.emit("todo.started", next);
      this.#changed();
      return `Started: [${next.id}] ${next.description}`;
    }
    return `No todo with id ${id}.`;
  }

  complete(id: string): string {
    const item = this.#todos.find((t) => t.id === id);
    if (item) {
      item.state = "completed";
      this.emit("todo.completed", item);
      this.#changed();
      return `Completed: [${item.id}] ${item.description}`;
    }
    return `No todo with id ${id}.`;
  }

  /** Set a task's state directly (the user's panel toggle). No-op if absent. */
  setState(id: string, state: TodoItem["state"]): void {
    const item = this.#todos.find((t) => t.id === id);
    if (!item || item.state === state) {
      return;
    }
    item.state = state;
    this.#changed();
  }

  remove(id: string): string {
    const idx = this.#todos.findIndex((t) => t.id === id);
    if (idx === -1) {
      return `No todo with id ${id}.`;
    }
    const removed = this.#todos.splice(idx, 1);
    const item = removed[0];
    if (!item) {
      return `No todo with id ${id}.`;
    }
    this.emit("todo.removed", item);
    this.#changed();
    return `Removed: [${item.id}] ${item.description}`;
  }

  reset(): void {
    this.#todos.length = 0;
    this.emit("todo.reset");
    this.#changed();
  }

  #changed(): void {
    this.emit("changed", [...this.#todos]);
  }

  list(): string {
    return (
      this.#todos
        .map((t) => `[${t.state}] ${t.id}: ${t.description}`)
        .join("\n") || "No todos."
    );
  }

  tool() {
    return tool({
      description: TODO_TOOL_DESCRIPTION,
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async ({ action, description, id }) => {
        if (action === "add") {
          const item = this.add(description ?? "(unnamed)");
          return `Added: [${item.id}] ${item.description}`;
        }
        if (action === "start") {
          return this.start(id ?? "");
        }
        if (action === "complete") {
          return this.complete(id ?? "");
        }
        if (action === "remove") {
          return this.remove(id ?? "");
        }
        if (action === "reset") {
          this.reset();
          return "All todos cleared.";
        }
        return this.list();
      },
      inputSchema: todoInputSchema,
    });
  }
}

export function createTodos(store: TodoStore = new TodoStore()) {
  return {
    store,
    tools: tagTools({ todo: store.tool() }, "builtin"),
  };
}
