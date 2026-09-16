import type { ModelMessage } from "ai";

import { describe, expect, it } from "vitest";

import {
  createInMemoryConversationStore,
  defaultThread,
} from "../../tools/context";

const m = (text: string): ModelMessage => ({ content: text, role: "user" });

describe("createInMemoryConversationStore", () => {
  it("returns [] for an unseen address", () => {
    const mesh = createInMemoryConversationStore();
    expect(mesh.load("space-1", "planning", "main")).toEqual([]);
  });

  it("appends and concatenates messages on round-trip", () => {
    const mesh = createInMemoryConversationStore();
    mesh.append("space-1", "planning", "main", [m("a"), m("b")]);
    mesh.append("space-1", "planning", "main", [m("c")]);
    expect(mesh.load("space-1", "planning", "main")).toEqual([
      m("a"),
      m("b"),
      m("c"),
    ]);
  });

  it("isolates by space, agent, and thread", () => {
    const mesh = createInMemoryConversationStore();
    mesh.append("space-1", "planning", "main", [m("p-main")]);
    mesh.append("space-1", "planning", "fork", [m("p-fork")]);
    mesh.append("space-1", "explorer", "main", [m("e-main")]);
    mesh.append("space-2", "planning", "main", [m("other-space")]);

    expect(mesh.load("space-1", "planning", "main")).toEqual([m("p-main")]);
    expect(mesh.load("space-1", "planning", "fork")).toEqual([m("p-fork")]);
    expect(mesh.load("space-1", "explorer", "main")).toEqual([m("e-main")]);
    expect(mesh.load("space-2", "planning", "main")).toEqual([
      m("other-space"),
    ]);
  });

  it("ignores empty append (no allocation, no entry)", () => {
    const mesh = createInMemoryConversationStore();
    mesh.append("space-1", "planning", "main", []);
    expect(mesh.load("space-1", "planning", "main")).toEqual([]);
  });

  it("exposes the default thread name", () => {
    expect(defaultThread()).toBe("main");
  });
});
