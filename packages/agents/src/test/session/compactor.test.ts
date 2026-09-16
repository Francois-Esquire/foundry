import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";

import type { TokenCounter } from "../../contexts/types";
import type { Summarizer } from "../../session/compactor";
import {
  compact,
  createModelSummarizer,
  maybeCompact,
  renderTranscript,
  selectMarker,
} from "../../session/compactor";
import { InMemorySessionStore } from "../../session/store";
import type {
  SessionMessage,
  SessionPart,
  SessionRole,
} from "../../session/types";
import { textGenerateResult } from "../helpers/mock-language-model";

const text = (t: string): SessionPart[] => [{ text: t, type: "text" }];
const labelOf = (m: SessionMessage): string =>
  m.parts[0]?.type === "text" ? m.parts[0].text : "";

function req<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

function fakeSummarizer(): Summarizer & { lastSeen: string[]; calls: number } {
  return {
    calls: 0,
    lastSeen: [],
    summarize(messages) {
      this.calls += 1;
      this.lastSeen = messages.map(labelOf);
      return Promise.resolve("SUMMARY");
    },
  };
}

async function seed(
  store: InMemorySessionStore,
  labels: string[]
): Promise<{ sessionId: string; ids: string[] }> {
  return seedRoles(
    store,
    labels.map((label) => ["user", label])
  );
}

async function seedRoles(
  store: InMemorySessionStore,
  items: [SessionRole, string][]
): Promise<{ sessionId: string; ids: string[] }> {
  const session = await store.createSession();
  const ids: string[] = [];
  for (const [role, label] of items) {
    const m = await store.appendMessage({
      parts: text(label),
      role,
      sessionId: session.id,
    });
    ids.push(m.id);
  }
  return { ids, sessionId: session.id };
}

const mk = (
  id: string,
  role: SessionRole,
  parts: SessionPart[] = []
): SessionMessage => ({
  createdAt: 0,
  id,
  parts,
  role,
  sessionId: "s",
  status: "complete",
  updatedAt: 0,
});

const capability = { kind: "mcp.tool", serverId: "s", tool: "danger" } as const;

describe("renderTranscript", () => {
  test("renders a pruned transcript: roles + tools, reasoning dropped", async () => {
    const store = new InMemorySessionStore();
    const session = await store.createSession();
    await store.appendMessage({
      parts: text("hello"),
      role: "user",
      sessionId: session.id,
    });
    await store.appendMessage({
      parts: [
        { text: "thinking", type: "reasoning" },
        {
          input: { q: "x" },
          name: "search",
          toolCallId: "c1",
          type: "tool_call",
        },
      ],
      role: "assistant",
      sessionId: session.id,
    });
    await store.appendMessage({
      parts: [{ output: { ok: true }, toolCallId: "c1", type: "tool_result" }],
      role: "tool",
      sessionId: session.id,
    });

    const out = await renderTranscript(await store.listMessages(session.id));

    expect(out).toContain("[user]");
    expect(out).toContain("hello");
    expect(out).not.toContain("thinking");
    expect(out).toContain("(tool_call search)");
    expect(out).toContain("(tool_result)");
  });
});

describe("createModelSummarizer", () => {
  test("returns the model's text, trimmed", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: () => Promise.resolve(textGenerateResult("  a summary  ")),
    });
    const summary = await createModelSummarizer({ model }).summarize([
      { parts: text("long conversation"), role: "user" } as SessionMessage,
    ]);
    expect(summary).toBe("a summary");
  });
});

describe("compact", () => {
  test("summarizes messages before the marker and persists via the store", async () => {
    const store = new InMemorySessionStore();
    const summarizer = fakeSummarizer();
    const { sessionId, ids } = await seed(store, ["m1", "m2", "m3", "m4"]);

    const result = await compact(store, summarizer, sessionId, req(ids[2]));

    if (result === null) {
      throw new Error("expected compaction");
    }
    expect(summarizer.lastSeen).toEqual(["m1", "m2"]);
    expect(result.summarizedIds).toEqual([ids[0], ids[1]]);

    const active = await store.activeMessages(sessionId);
    expect(active.map((m) => m.role)).toEqual(["summary", "user", "user"]);
    expect(active.map(labelOf)).toEqual(["SUMMARY", "m3", "m4"]);
  });

  test("is a no-op when nothing precedes the marker", async () => {
    const store = new InMemorySessionStore();
    const summarizer = fakeSummarizer();
    const { sessionId, ids } = await seed(store, ["m1", "m2"]);

    expect(await compact(store, summarizer, sessionId, req(ids[0]))).toBeNull();
    expect(summarizer.calls).toBe(0);
  });

  test("repeat compaction folds the prior summary into the new one", async () => {
    const store = new InMemorySessionStore();
    const summarizer = fakeSummarizer();
    const { sessionId, ids } = await seed(store, ["m1", "m2", "m3", "m4"]);

    await compact(store, summarizer, sessionId, req(ids[2])); // fold m1,m2 -> S1
    expect(summarizer.lastSeen).toEqual(["m1", "m2"]);

    const m5 = await store.appendMessage({
      parts: text("m5"),
      role: "user",
      sessionId,
    });
    await store.appendMessage({ parts: text("m6"), role: "user", sessionId });

    const result = await compact(store, summarizer, sessionId, m5.id); // fold S1,m3,m4 -> S2
    if (result === null) {
      throw new Error("expected compaction");
    }

    // prior summary is fed back in (not filtered out), so S2 subsumes S1
    expect(summarizer.lastSeen).toEqual(["SUMMARY", "m3", "m4"]);

    // only the latest summary surfaces, prepended to the recent tail
    const active = await store.activeMessages(sessionId);
    expect(active.map((m) => m.role)).toEqual(["summary", "user", "user"]);
    expect(active.map(labelOf)).toEqual(["SUMMARY", "m5", "m6"]);
  });

  test("real summarizer over a simulated model", async () => {
    const store = new InMemorySessionStore();
    let generateCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: () => {
        generateCalls += 1;
        return Promise.resolve(textGenerateResult("[recap]"));
      },
    });
    const { sessionId, ids } = await seed(store, ["m1", "m2", "m3"]);

    const result = await compact(
      store,
      createModelSummarizer({ model }),
      sessionId,
      req(ids[2])
    );

    if (result === null) {
      throw new Error("expected compaction");
    }
    expect(generateCalls).toBe(1);
    const active = await store.activeMessages(sessionId);
    expect(active.map((m) => m.role)).toEqual(["summary", "user"]);
    expect(active[0]?.parts[0]).toEqual({ text: "[recap]", type: "text" });
  });
});

describe("selectMarker", () => {
  const one: TokenCounter = { count: () => 1 };

  test("snaps the keep-boundary to a user turn, folding whole turns", () => {
    const msgs = [
      mk("u1", "user"),
      mk("a1", "assistant"),
      mk("t1", "tool"),
      mk("u2", "user"),
      mk("a2", "assistant"),
    ];
    // keep last 2 tokens → boundary lands on u2; tool pair (a1/t1) folds together
    expect(selectMarker(msgs, 2, one)).toBe("u2");
  });

  test("returns undefined when nothing precedes the boundary", () => {
    const msgs = [mk("u1", "user"), mk("a1", "assistant")];
    expect(selectMarker(msgs, 99, one)).toBeUndefined();
  });

  test("never folds a message holding an unresolved approval request, even outside the keep window", () => {
    const msgs = [
      mk("u1", "user"),
      mk("a1", "assistant", [
        {
          approvalId: "appr-1",
          capability,
          input: {},
          name: "danger",
          toolCallId: "c1",
          type: "tool_approval_request",
        },
      ]),
      mk("u2", "user"),
      mk("a2", "assistant"),
      mk("u3", "user"),
      mk("a3", "assistant"),
    ];
    // keep-window would normally land the boundary at u3, folding a1's
    // unresolved request away — it must instead stay in the active tail.
    expect(selectMarker(msgs, 2, one)).toBe("a1");
  });

  test("folds a resolved approval pair normally once a response exists", () => {
    const msgs = [
      mk("u1", "user"),
      mk("a1", "assistant", [
        {
          approvalId: "appr-1",
          capability,
          input: {},
          name: "danger",
          toolCallId: "c1",
          type: "tool_approval_request",
        },
      ]),
      mk("t1", "tool", [
        {
          approvalId: "appr-1",
          approved: true,
          type: "tool_approval_response",
        },
      ]),
      mk("u2", "user"),
      mk("a2", "assistant"),
    ];
    expect(selectMarker(msgs, 2, one)).toBe("u2");
  });
});

describe("maybeCompact", () => {
  test("no-op when the active context is under the limit", async () => {
    const store = new InMemorySessionStore();
    const summarizer = fakeSummarizer();
    const { sessionId } = await seed(store, ["m1", "m2"]);

    const result = await maybeCompact(store, summarizer, sessionId, {
      counter: { count: () => 10 },
      keepTokens: 100,
      limit: 1000,
    });

    expect(result).toBeNull();
    expect(summarizer.calls).toBe(0);
  });

  test("folds older history once the active context exceeds the limit", async () => {
    const store = new InMemorySessionStore();
    const summarizer = fakeSummarizer();
    const { sessionId } = await seedRoles(store, [
      ["user", "u1"],
      ["assistant", "a1"],
      ["user", "u2"],
      ["assistant", "a2"],
    ]);

    const result = await maybeCompact(store, summarizer, sessionId, {
      counter: { count: () => 10 },
      keepTokens: 15,
      limit: 25, // 4 messages * 10 = 40 > 25
    });

    if (result === null) {
      throw new Error("expected compaction");
    }
    expect(summarizer.lastSeen).toEqual(["u1", "a1"]);

    const active = await store.activeMessages(sessionId);
    expect(active.map((m) => m.role)).toEqual(["summary", "user", "assistant"]);
    expect(active.map(labelOf)).toEqual(["SUMMARY", "u2", "a2"]);
  });
});
