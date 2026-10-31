import type { ModelMessage } from "ai";

import { describe, expect, it } from "vitest";

import {
  createInMemoryConversationStore,
  defaultThread,
} from "../../tools/context";

const m = (text: string): ModelMessage => ({ content: text, role: "user" });

describe("createInMemoryConversationStore", () => {
  it("returns [] for an unseen address", () => {
    const store = createInMemoryConversationStore();
    expect(store.load("space-1", "planning", "main")).toEqual([]);
  });

  it("appends and concatenates messages on round-trip", () => {
    const store = createInMemoryConversationStore();
    store.append("space-1", "planning", "main", [m("a"), m("b")]);
    store.append("space-1", "planning", "main", [m("c")]);
    expect(store.load("space-1", "planning", "main")).toEqual([
      m("a"),
      m("b"),
      m("c"),
    ]);
  });

  it("isolates by space, agent, and thread", () => {
    const store = createInMemoryConversationStore();
    store.append("space-1", "planning", "main", [m("p-main")]);
    store.append("space-1", "planning", "fork", [m("p-fork")]);
    store.append("space-1", "explorer", "main", [m("e-main")]);
    store.append("space-2", "planning", "main", [m("other-space")]);

    expect(store.load("space-1", "planning", "main")).toEqual([m("p-main")]);
    expect(store.load("space-1", "planning", "fork")).toEqual([m("p-fork")]);
    expect(store.load("space-1", "explorer", "main")).toEqual([m("e-main")]);
    expect(store.load("space-2", "planning", "main")).toEqual([
      m("other-space"),
    ]);
  });

  it("keeps addresses apart when a part contains the separator", () => {
    const store = createInMemoryConversationStore();
    store.append("space", "planning-main", "x", [m("first")]);
    store.append("space-planning", "main", "x", [m("second")]);
    store.append("space", "planning", "main-x", [m("third")]);

    expect(store.load("space", "planning-main", "x")).toEqual([m("first")]);
    expect(store.load("space-planning", "main", "x")).toEqual([m("second")]);
    expect(store.load("space", "planning", "main-x")).toEqual([m("third")]);
  });

  it("ignores empty append (no allocation, no entry)", () => {
    const store = createInMemoryConversationStore();
    store.append("space-1", "planning", "main", []);
    expect(store.load("space-1", "planning", "main")).toEqual([]);
  });

  it("exposes the default thread name", () => {
    expect(defaultThread()).toBe("main");
  });
});
