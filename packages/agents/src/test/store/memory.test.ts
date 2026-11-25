import { describe, expect, it } from "vitest";
import { SessionWindow } from "../../contexts/session-window";
import type { SessionChangeEvent } from "../../schema";
import type { SessionStore } from "../../store";
import { MemorySessionStore } from "../../store/memory";
import { describeSessionStore } from "../../testing/store";

describeSessionStore(
  "MemorySessionStore",
  () => {
    const scopes = new Map<string, SessionStore>();
    return (scope) => {
      const store = scopes.get(scope) ?? new MemorySessionStore();
      scopes.set(scope, store);
      return store;
    };
  },
  { hooked: false }
);

describeSessionStore(
  "SessionWindow over MemorySessionStore",
  () => {
    const scopes = new Map<string, SessionStore>();
    return (scope) => {
      const store =
        scopes.get(scope) ?? new SessionWindow(new MemorySessionStore());
      scopes.set(scope, store);
      return store;
    };
  },
  { hooked: false }
);

describe("MemorySessionStore events", () => {
  it("refuses whole a write whose events it cannot copy", async () => {
    const store = new MemorySessionStore();
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
