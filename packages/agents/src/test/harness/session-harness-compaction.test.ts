import { describe, expect, it } from "vitest";
import { SessionHarness } from "../../harness";
import type {
  CreateMessageInput,
  CreateSessionInput,
  SessionEvent,
  SessionStore,
  Summarizer,
  UpdateMessageInput,
  UpdateSessionInput,
} from "../../session";
import { InMemorySessionStore } from "../../session";
import {
  createScriptedMockModel,
  usageStreamResult,
} from "../helpers/mock-language-model";

async function drain(
  stream: AsyncIterable<SessionEvent>
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

function fakeSummarizer(): Summarizer & { calls: number; lastSeen: string[] } {
  return {
    calls: 0,
    lastSeen: [],
    summarize(messages) {
      this.calls += 1;
      this.lastSeen = messages.map((m) =>
        m.parts[0]?.type === "text" ? m.parts[0].text : ""
      );
      return Promise.resolve("RECAP");
    },
  };
}

/** Turn 1 reports 200 input tokens; the window limit below is 100 → over budget. */
function overBudgetModel() {
  return createScriptedMockModel({
    stream: [usageStreamResult("ok", 200, 0), usageStreamResult("ok2", 0, 0)],
  });
}

/** A `SessionStore` that is NOT summarize-aware (no `activeMessages`). */
class BareStore implements SessionStore {
  readonly #inner = new InMemorySessionStore();
  createSession(input?: CreateSessionInput) {
    return this.#inner.createSession(input);
  }
  getSession(id: string) {
    return this.#inner.getSession(id);
  }
  updateSession(id: string, patch: UpdateSessionInput) {
    return this.#inner.updateSession(id, patch);
  }
  appendMessage(input: CreateMessageInput) {
    return this.#inner.appendMessage(input);
  }
  updateMessage(id: string, patch: UpdateMessageInput) {
    return this.#inner.updateMessage(id, patch);
  }
  listMessages(sessionId: string) {
    return this.#inner.listMessages(sessionId);
  }
}

const SMALL_WINDOW = { contextWindow: 100, id: "test" };
const TIGHT = {
  highWaterRatio: 1,
  reservedOutput: 0,
  safetyMarginRatio: 0,
} as const;

describe("SessionHarness — auto compaction", () => {
  it("folds older history before a turn once over budget", async () => {
    const store = new InMemorySessionStore();
    const summarizer = fakeSummarizer();
    const harness = new SessionHarness(
      {
        compaction: {
          keepTokens: 1,
          model: SMALL_WINDOW,
          summarizer,
          window: TIGHT,
        },
        instructions: "x",
        model: overBudgetModel(),
        sessionId: "s",
        store,
        tools: {},
      },
      { sessionId: "s" }
    );

    await drain(harness.stream("first")); // no prior usage yet → no compaction
    expect(summarizer.calls).toBe(0);

    await drain(harness.stream("second")); // prior assistant usage 200 > 100 → compact
    expect(summarizer.calls).toBe(1);
    expect(summarizer.lastSeen).toEqual(["first", "ok"]);

    const active = await store.activeMessages("s");
    expect(active.map((m) => m.role)).toEqual(["summary", "user", "assistant"]);
  });

  it("never breaks the turn when the summarizer throws (best-effort)", async () => {
    const store = new InMemorySessionStore();
    const summarizer: Summarizer = {
      summarize: () => Promise.reject(new Error("boom")),
    };
    const harness = new SessionHarness(
      {
        compaction: {
          keepTokens: 1,
          model: SMALL_WINDOW,
          summarizer,
          window: TIGHT,
        },
        instructions: "x",
        model: overBudgetModel(),
        sessionId: "s",
        store,
        tools: {},
      },
      { sessionId: "s" }
    );

    await drain(harness.stream("first"));
    const events = await drain(harness.stream("second"));

    // the turn still produced its assistant reply, no summary was written
    expect(events.some((e) => e.type === "finish")).toBe(true);
    const messages = await store.listMessages("s");
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("does nothing without a compaction config", async () => {
    const store = new InMemorySessionStore();
    const harness = new SessionHarness(
      { instructions: "x", model: overBudgetModel(), store, tools: {} },
      { sessionId: "s" }
    );

    await drain(harness.stream("first"));
    await drain(harness.stream("second"));

    const messages = await store.listMessages("s");
    expect(messages.some((m) => m.role === "summary")).toBe(false);
  });

  it("skips compaction for a non-summarize-aware store", async () => {
    const summarizer = fakeSummarizer();
    const harness = new SessionHarness(
      {
        compaction: {
          keepTokens: 1,
          model: SMALL_WINDOW,
          summarizer,
          window: TIGHT,
        },
        instructions: "x",
        model: overBudgetModel(),
        store: new BareStore(),
        tools: {},
      },
      { sessionId: "s" }
    );

    await drain(harness.stream("first"));
    await drain(harness.stream("second"));

    expect(summarizer.calls).toBe(0);
  });
});
