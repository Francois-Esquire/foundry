import { describe, expect, it } from "vitest";

import type { WindowModel } from "../../contexts";

import { SessionWindow } from "../../contexts";
import { InMemorySessionStore } from "../../session/store";

const MODEL: WindowModel = { contextWindow: 1000, id: "test-model" };

async function seed(store: InMemorySessionStore, sessionId: string) {
  await store.appendMessage({
    parts: [{ text: "hi", type: "text" }],
    role: "user",
    sessionId,
  });
  await store.appendMessage({
    parts: [{ text: "hello there", type: "text" }],
    role: "assistant",
    sessionId,
  });
}

describe("SessionWindow", () => {
  it("delegates every SessionStore method to the wrapped store", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner);

    const session = await window.createSession({ title: "t" });
    expect(await window.getSession(session.id)).toEqual(session);

    const msg = await window.appendMessage({
      parts: [{ text: "hi", type: "text" }],
      role: "user",
      sessionId: session.id,
    });
    // Written through to the wrapped store, not a private copy.
    expect(await inner.listMessages(session.id)).toEqual([msg]);

    await window.updateMessage(msg.id, { status: "error" });
    const after = await window.listMessages(session.id);
    expect(after[0]?.status).toBe("error");

    const updated = await window.updateSession(session.id, { title: "t2" });
    expect(updated?.title).toBe("t2");
  });

  it("listMessages stays a raw full-history passthrough", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner);
    const session = await window.createSession();
    await seed(inner, session.id);

    expect(await window.listMessages(session.id)).toEqual(
      await inner.listMessages(session.id)
    );
  });

  it("windowFor returns the full history unchanged (Phase 1 no-op)", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner);
    const session = await window.createSession();
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
    const session = await window.createSession();
    await seed(inner, session.id);

    const { budget } = await window.windowFor(session.id, MODEL);
    expect(budget.window).toBe(1000);
    expect(budget.reservedOutput).toBe(200);
    expect(budget.headroom).toBeLessThan(budget.window);
  });

  it("flags overBudget when a hard token limit is crossed", async () => {
    const inner = new InMemorySessionStore();
    const window = new SessionWindow(inner, { hardTokenLimit: 1 });
    const session = await window.createSession();
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
