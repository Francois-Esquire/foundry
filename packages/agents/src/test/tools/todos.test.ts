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

    store.setState("x", "completed");
    store.setState("missing", "pending");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("emits a snapshot copy, not the live array", () => {
    const store = new TodoStore();
    let captured: TodoItem[] | undefined;
    store.on("changed", (items) => {
      captured = items;
    });
    store.add("first");
    store.add("second");
    expect(captured).toHaveLength(2);
    const firstSnapshot = captured;
    store.complete(store.items[0]?.id ?? "");
    expect(firstSnapshot).not.toBe(captured);
  });

  it("supports once, repeated registrations, off/removeListener, and removeAllListeners", () => {
    const store = new TodoStore();
    const onceAdded = vi.fn();
    const repeated = vi.fn();

    store.once("todo.added", onceAdded);
    store.on("todo.added", repeated);
    store.on("todo.added", repeated);

    store.add("one");
    store.add("two");

    expect(onceAdded).toHaveBeenCalledTimes(1);
    expect(repeated).toHaveBeenCalledTimes(4);

    store.off("todo.added", repeated);
    store.add("three");
    expect(repeated).toHaveBeenCalledTimes(5);

    store.removeListener("todo.added", repeated);
    store.add("four");
    expect(repeated).toHaveBeenCalledTimes(5);

    const onChanged = vi.fn();
    store.on("changed", onChanged);
    store.removeAllListeners("changed");
    store.add("five");
    expect(onChanged).not.toHaveBeenCalled();

    const onReset = vi.fn();
    store.on("todo.reset", onReset);
    store.removeAllListeners();
    store.reset();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("fires once listeners only once across recursive emits and binds `this` to the TodoStore", () => {
    const store = new TodoStore();
    let recursed = false;
    let boundThis: unknown;
    const onceListener = vi.fn(function (this: unknown) {
      boundThis = this;
    });

    store.on("todo.added", () => {
      if (!recursed) {
        recursed = true;
        store.add("inner");
      }
    });
    store.once("todo.added", onceListener);

    store.add("outer");

    expect(onceListener).toHaveBeenCalledTimes(1);
    expect(boundThis).toBe(store);
  });
});
