import { describe, expect, it } from "vitest";

import { SessionWindow } from "../../contexts/session-window";
import type { WindowModel } from "../../contexts/types";
import { Sessions } from "../../session/sessions";
import { InMemorySessionStore } from "../../store/memory";

const MODEL: WindowModel = { contextWindow: 1000, id: "test-model" };

async function seed(store: InMemorySessionStore, sessionId: string) {
  const sessions = new Sessions({ store });
  await sessions.appendMessage({
    parts: [{ text: "hi", type: "text" }],
    role: "user",
    sessionId,
  });
  await sessions.appendMessage({
    parts: [{ text: "hello there", type: "text" }],
    role: "assistant",
    sessionId,
  });
}

describe("SessionWindow", () => {
  it("delegates every SessionStore method to the wrapped store", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner);

    const sessions = new Sessions({ store: window });
    const session = await sessions.createSession({ title: "t" });
    expect(await window.getSession(session.id)).toEqual(session);

    const msg = await sessions.appendMessage({
      parts: [{ text: "hi", type: "text" }],
      role: "user",
      sessionId: session.id,
    });
    expect(await inner.listMessages(session.id)).toEqual([msg]);

    await sessions.updateMessage(msg.id, { status: "error" });
    const after = await window.listMessages(session.id);
    expect(after[0]?.status).toBe("error");

    const updated = await sessions.updateSession(session.id, { title: "t2" });
    expect(updated?.title).toBe("t2");
  });

  it("forwards the wrapped store's transaction, so two Sessions over it keep both updates", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner);
    const a = new Sessions({ store: window });
    const b = new Sessions({ store: window });
    await a.createSession({ id: "s" });

    await Promise.all([
      a.updateSession("s", { title: "renamed" }),
      b.updateSession("s", { status: "archived" }),
    ]);

    await expect(inner.getSession("s")).resolves.toMatchObject({
      status: "archived",
      title: "renamed",
    });
  });

  it("offers no transaction over a store without one", () => {
    const inner = new InMemorySessionStore();
    const bare = new SessionWindow({
      commit: (write) => inner.commit(write),
      getMessage: (id) => inner.getMessage(id),
      getSession: (id) => inner.getSession(id),
      listMessages: (sessionId) => inner.listMessages(sessionId),
    });

    expect(bare.transaction).toBeUndefined();
  });

  it("listMessages stays a raw full-history passthrough", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner);
    const session = await new Sessions({ store: window }).createSession();
    await seed(inner, session.id);

    expect(await window.listMessages(session.id)).toEqual(
      await inner.listMessages(session.id)
    );
  });

  it("windowFor returns the full history unchanged", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner);
    const session = await new Sessions({ store: window }).createSession();
    await seed(inner, session.id);

    const result = await window.windowFor(session.id, MODEL);
    expect(result.messages).toEqual(await inner.listMessages(session.id));
    expect(result.plan.summarized).toBe(false);
    expect(result.plan.dropped).toEqual([]);
    expect(result.plan.estimatedTokens).toBeGreaterThan(0);
  });

  it("derives a budget with headroom below the window", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner, { reservedOutput: 200 });
    const session = await new Sessions({ store: window }).createSession();
    await seed(inner, session.id);

    const { budget } = await window.windowFor(session.id, MODEL);
    expect(budget.window).toBe(1000);
    expect(budget.reservedOutput).toBe(200);
    expect(budget.headroom).toBeLessThan(budget.window);
  });

  it("flags overBudget when a hard token limit is crossed", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner, { hardTokenLimit: 1 });
    const session = await new Sessions({ store: window }).createSession();
    await seed(inner, session.id);

    const { plan } = await window.windowFor(session.id, MODEL);
    expect(plan.overBudget).toBe(true);
  });

  it("records usage and computes turn-to-turn velocity", () => {
    const window = new SessionWindow(new InMemorySessionStore());
    window.recordUsage("s", {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    });
    expect(window.stateFor("s")?.velocity).toBeUndefined();

    window.recordUsage("s", {
      inputTokens: 180,
      outputTokens: 20,
      totalTokens: 200,
    });
    expect(window.stateFor("s")?.lastInputTokens).toBe(180);
    expect(window.stateFor("s")?.velocity).toBe(80);
  });
});
