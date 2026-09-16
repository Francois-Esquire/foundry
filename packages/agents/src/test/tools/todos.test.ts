import { describe, expect, it, vi } from "vitest";

import type { TodoItem } from "../../tools/todos";

import { TodoStore } from "../../tools/todos";

describe("TodoStore", () => {
  it("emits `changed` with the current list on every mutation", () => {
    const store = new TodoStore();
    const seen: TodoItem[][] = [];
    store.on("changed", (items) => seen.push(items));

    const a = store.add("first");
    store.complete(a.id);
    store.add("second");

    expect(seen).toHaveLength(3);
    // Last snapshot reflects both items, first completed.
    expect(seen.at(-1)).toEqual([
      { description: "first", id: a.id, state: "completed" },
      expect.objectContaining({ description: "second", state: "pending" }),
    ]);
  });

  it("hydrate replaces the list and fires a single `changed`", () => {
    const store = new TodoStore();
    store.add("stale");
    const onChanged = vi.fn();
    store.on("changed", onChanged);

    store.hydrate([
      { description: "loaded", id: "x", state: "in_progress" },
      { description: "also", id: "y", state: "completed" },
    ]);

    expect(onChanged).toHaveBeenCalledTimes(1);
    expect([...store.items]).toEqual([
      { description: "loaded", id: "x", state: "in_progress" },
      { description: "also", id: "y", state: "completed" },
    ]);
  });

  it("setState changes one task's state and emits; no-op when unchanged or absent", () => {
    const store = new TodoStore();
    store.hydrate([{ description: "task", id: "x", state: "pending" }]);
    const onChanged = vi.fn();
    store.on("changed", onChanged);

    store.setState("x", "completed");
    expect([...store.items]).toEqual([
      { description: "task", id: "x", state: "completed" },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);

    // Same state → no event; unknown id → no event.
    store.setState("x", "completed");
    store.setState("missing", "pending");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("emits a snapshot copy, not the live array", () => {
    const store = new TodoStore();
    let captured: TodoItem[] | undefined;
    store.on("changed", (items) => (captured = items));
    store.add("first");
    store.add("second");
    // The first snapshot must not have grown when the second item was added.
    expect(captured).toHaveLength(2);
    const firstSnapshot = captured;
    store.complete(store.items[0]?.id ?? "");
    expect(firstSnapshot).not.toBe(captured);
  });
});
