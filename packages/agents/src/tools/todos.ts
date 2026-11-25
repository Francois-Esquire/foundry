import { tool } from "ai";
import { z } from "zod";

import { tagTools } from "../harness/types";

type EventListener<Args extends unknown[]> = (...args: Args) => void;

interface ListenerEntry {
  fired: boolean;
  readonly fn: (...args: unknown[]) => void;
  readonly once: boolean;
}

class TypedEventEmitter<Events extends { [K in keyof Events]: unknown[] }> {
  readonly #listeners = new Map<keyof Events, ListenerEntry[]>();

  on<K extends keyof Events>(
    event: K,
    listener: EventListener<Events[K]>
  ): this {
    return this.#add(event, listener, false);
  }

  once<K extends keyof Events>(
    event: K,
    listener: EventListener<Events[K]>
  ): this {
    return this.#add(event, listener, true);
  }

  off<K extends keyof Events>(
    event: K,
    listener: EventListener<Events[K]>
  ): this {
    return this.removeListener(event, listener);
  }

  removeListener<K extends keyof Events>(
    event: K,
    listener: EventListener<Events[K]>
  ): this {
    const entries = this.#listeners.get(event);
    if (!entries) {
      return this;
    }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.fn === listener) {
        entries.splice(i, 1);
        break;
      }
    }
    if (entries.length === 0) {
      this.#listeners.delete(event);
    }
    return this;
  }

  removeAllListeners<K extends keyof Events>(event?: K): this {
    if (event === undefined) {
      this.#listeners.clear();
    } else {
      this.#listeners.delete(event);
    }
    return this;
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const entries = this.#listeners.get(event);
    if (!entries || entries.length === 0) {
      return false;
    }
    for (const entry of [...entries]) {
      if (entry.once) {
        if (entry.fired) {
          continue;
        }
        entry.fired = true;
        const index = entries.indexOf(entry);
        if (index !== -1) {
          entries.splice(index, 1);
        }
        if (entries.length === 0) {
          this.#listeners.delete(event);
        }
      }
      entry.fn.apply(this, args);
    }
    return true;
  }

  #add<K extends keyof Events>(
    event: K,
    listener: EventListener<Events[K]>,
    once: boolean
  ): this {
    let entries = this.#listeners.get(event);
    if (!entries) {
      entries = [];
      this.#listeners.set(event, entries);
    }
    entries.push({
      fired: false,
      fn: listener as (...args: unknown[]) => void,
      once,
    });
    return this;
  }
}

export interface TodoItem {
  description: string;
  id: string;
  state: "pending" | "in_progress" | "completed";
}

export interface TodoEventMap {
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

export class TodoStore extends TypedEventEmitter<TodoEventMap> {
  readonly #todos: TodoItem[] = [];

  constructor(todos: TodoItem[] = []) {
    super();
    this.#todos = todos;
  }

  get items(): readonly TodoItem[] {
    return this.#todos;
  }

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
    const [item] = removed;
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
