import { describe, expect, it } from "vitest";
import { SessionWindow } from "../../contexts/session-window";
import type { SessionChangeEvent } from "../../schema";
import type { SessionStore } from "../../store";
import { InMemorySessionStore } from "../../store/memory";
import { describeSessionStore } from "../../testing/store";

// Memory has no shared medium, so each scope is its own store, and asking
// for a scope again returns that same store.
describeSessionStore("InMemorySessionStore", () => {
  const scopes = new Map<string, SessionStore>();
  return (scope) => {
    const store = scopes.get(scope) ?? new InMemorySessionStore();
    scopes.set(scope, store);
    return store;
  };
});

// A window forwards the store it wraps, refusals from inside a transaction
// included.
describeSessionStore("SessionWindow over InMemorySessionStore", () => {
  const scopes = new Map<string, SessionStore>();
  return (scope) => {
    const store =
      scopes.get(scope) ?? new SessionWindow(new InMemorySessionStore());
    scopes.set(scope, store);
    return store;
  };
});

describe("InMemorySessionStore events", () => {
  it("refuses whole a write whose events it cannot copy", async () => {
    const store = new InMemorySessionStore();
    const unplain = {
      at: () => "now",
      id: "e",
      sessionId: "s",
      type: "session.created",
    } as unknown as SessionChangeEvent;
    const record = {
      createdAt: 1,
      id: "s",
      parentMessageId: null,
      parentSessionId: null,
      status: "active" as const,
      title: null,
      updatedAt: 1,
    };

    await expect(
      store.commit({ events: [unplain], putSessions: [record] })
    ).rejects.toThrow();
    await expect(store.getSession("s")).resolves.toBeNull();
  });
});
