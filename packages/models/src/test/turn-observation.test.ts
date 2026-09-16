import type { LanguageModelV4Usage } from "@ai-sdk/provider";

import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { beginTurnObservation, configureModelObservability } from "../logger";

// beginTurnObservation owns the unit-of-work the model wrap can't see: a whole
// tool-loop turn. observe() wraps the model + hands back telemetry; emit()
// settles ONE wide event for the turn. These tests prove the wrap accumulates
// and emit() flushes — the piece createAIMiddleware alone never did.

interface AiEvent {
  ai?: { model?: string; totalTokens?: number };
  error?: { message?: string };
}

const USAGE: LanguageModelV4Usage = {
  inputTokens: {
    cacheRead: undefined,
    cacheWrite: undefined,
    noCache: 3,
    total: 3,
  },
  outputTokens: { reasoning: undefined, text: 10, total: 10 },
};

function drain(events: AiEvent[]) {
  configureModelObservability({
    enabled: true,
    logger: {
      drain: (ctx) => {
        events.push(ctx.event as AiEvent);
      },
    },
  });
}

function generatingModel() {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ text: "hello world", type: "text" }],
        finishReason: { raw: undefined, unified: "stop" },
        usage: USAGE,
        warnings: [],
      }),
    modelId: "openai/gpt-5-mini",
  });
}

beforeEach(() => {
  configureModelObservability({ enabled: true });
});
afterEach(() => {
  configureModelObservability({ enabled: true });
});

describe("beginTurnObservation", () => {
  it("returns null when observability is disabled", () => {
    configureModelObservability({ enabled: false });
    expect(beginTurnObservation()).toBeNull();
  });

  it("accumulates usage during the turn and emits exactly one event on settle", async () => {
    const events: AiEvent[] = [];
    drain(events);

    const obs = beginTurnObservation({
      model: "openai/gpt-5-mini",
      provider: "vercel",
    });
    if (!obs) {
      throw new Error("expected an observation when enabled");
    }

    const result = await generateText({
      experimental_telemetry: obs.telemetry,
      model: obs.wrap(generatingModel()),
      prompt: "hi",
    });
    expect(result.text).toBe("hello world");

    // The wrap only set()s; nothing is emitted until the turn owner says so.
    expect(events).toHaveLength(0);

    obs.emit();
    expect(events).toHaveLength(1);
    expect(events[0]?.ai?.model).toBe("openai/gpt-5-mini");
    expect(events[0]?.ai?.totalTokens).toBe(13);
  });

  it("records an error on the wide event and emits once", () => {
    const events: AiEvent[] = [];
    drain(events);

    const obs = beginTurnObservation({ model: "openai/gpt-5-mini" });
    if (!obs) {
      throw new Error("expected an observation when enabled");
    }

    obs.emit(new Error("turn blew up"));
    expect(events).toHaveLength(1);
    expect(events[0]?.error?.message).toBe("turn blew up");
  });

  it("is idempotent — a second emit is a no-op", () => {
    const events: AiEvent[] = [];
    drain(events);

    const obs = beginTurnObservation({ model: "openai/gpt-5-mini" });
    if (!obs) {
      throw new Error("expected an observation when enabled");
    }

    obs.emit();
    obs.emit();
    expect(events).toHaveLength(1);
  });
});
