import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionPart, SessionStore } from "@foundry/agents/session";
import { agent, step } from "@foundry/quirks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindAgents } from "~/agents";
import { CLAUDE_CODE } from "~/harnesses";
import { registry } from "~/lib/registry";
import { mockModels } from "~/models/echo";
import { JsonSessionStore } from "~/sessions/json-store";
import { sessionLines } from "~/sessions/list";

afterEach(() => {
  registry.reset();
  vi.useRealTimers();
});

const executors = [CLAUDE_CODE];

function bind(sessions: SessionStore) {
  const models = mockModels(executors, ({ prompt }) =>
    prompt.includes("Summarize") ? "the gist" : "noted"
  );
  registry.bind({
    agents: bindAgents({
      executors,
      models,
      sessions,
      skills: () => Promise.resolve([]),
    }),
    executors,
    log: () => undefined,
    sessions,
  } as never);
}

describe("JsonSessionStore", () => {
  it("survives a new process: a fresh store over the same dir sees the turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quirks-sessions-"));
    bind(new JsonSessionStore(dir));
    const reviewer = agent("reviewer", { prompt: "Review." });
    const ask = step("ask", async ({ agents }, input: string) => {
      const session = await agents.session(reviewer, { sessionId: "nightly" });
      await session.generate(input);
      return null;
    });
    await ask.create().run("first");
    await ask.create().run("second");

    const reopened = new JsonSessionStore(dir);
    const [record] = reopened.sessions();
    expect(record?.id).toBe("nightly");
    const messages = await reopened.listMessages("nightly");
    expect(record?.updatedAt).toBe(messages.at(-1)?.createdAt);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("compacts a session whose history outgrows a tiny window, in one write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quirks-sessions-"));
    const store = new JsonSessionStore(dir);
    bind(store);
    const chatty = agent("chatty", { prompt: "Talk." });
    const ask = step("ask", async ({ agents }, input: string) => {
      const session = await agents.session(chatty, {
        compaction: {
          keepTokens: 20,
          model: { contextWindow: 400, id: "opus", maxOutputTokens: 50 },
        },
        sessionId: "long",
      });
      await session.generate(input);
      return null;
    });
    for (let i = 0; i < 12; i += 1) {
      await ask.create().run(`turn ${String(i)} ${"x".repeat(200)}`);
    }

    const all = await store.listMessages("long");
    const active = await store.activeMessages("long");
    expect(all.some((m) => m.role === "summary")).toBe(true);
    expect(active.length).toBeLessThan(all.length);
    expect(new JsonSessionStore(dir).sessions()).toHaveLength(1);
  });
});

describe("sessionLines", () => {
  it("lists id, count, updated, and summary flag, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const dir = mkdtempSync(join(tmpdir(), "quirks-sessions-"));
    const store = new JsonSessionStore(dir);
    const text: SessionPart[] = [{ text: "hi", type: "text" }];

    vi.setSystemTime(new Date("2026-09-10T10:00:00.000Z"));
    await store.createSession({ id: "older" });
    await store.appendMessage({
      parts: text,
      role: "user",
      sessionId: "older",
    });
    const reply = await store.appendMessage({
      parts: text,
      role: "assistant",
      sessionId: "older",
    });
    await store.summarize({
      messageId: reply.id,
      sessionId: "older",
      summary: { parts: text },
    });

    vi.setSystemTime(new Date("2026-09-10T11:00:00.000Z"));
    await store.createSession({ id: "newer" });
    await store.appendMessage({
      parts: text,
      role: "user",
      sessionId: "newer",
    });

    expect(await sessionLines(store)).toEqual([
      "newer  1 messages  2026-09-10T11:00:00.000Z  summary: no",
      "older  3 messages  2026-09-10T10:00:00.000Z  summary: yes",
    ]);
  });
});
