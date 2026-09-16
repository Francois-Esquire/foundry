import { describe, expect, it } from "vitest";

import {
  normalizeMessageMetadata,
  normalizeUsage,
} from "../../session/metadata";

describe("normalizeUsage", () => {
  it("returns undefined for an absent blob", () => {
    expect(normalizeUsage(null)).toBeUndefined();
    expect(normalizeUsage(undefined)).toBeUndefined();
  });

  it("keeps the required token fields and drops absent optionals", () => {
    expect(
      normalizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("carries cache-read and cache-write tokens when present", () => {
    expect(
      normalizeUsage({
        cachedInputTokens: 8,
        cacheWriteTokens: 3,
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 15,
      })
    ).toEqual({
      cachedInputTokens: 8,
      cacheWriteTokens: 3,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 15,
    });
  });

  it("drops unknown fields a store may carry", () => {
    const result = normalizeUsage({
      inputTokens: 1,
      outputTokens: 1,
      // @ts-expect-error — a store row may carry fields outside the canonical shape
      somethingElse: 99,
      totalTokens: 2,
    });
    expect(result).not.toHaveProperty("somethingElse");
  });
});

describe("normalizeMessageMetadata", () => {
  it("returns undefined for an absent blob", () => {
    expect(normalizeMessageMetadata(null)).toBeUndefined();
    expect(normalizeMessageMetadata(undefined)).toBeUndefined();
  });

  it("projects model, usage, and timing onto the canonical shape", () => {
    expect(
      normalizeMessageMetadata({
        model: {
          harness: "studio",
          id: "claude-opus-4-8",
          provider: "anthropic",
        },
        timing: { completedAt: 3, durationMs: 2, startedAt: 1 },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })
    ).toEqual({
      model: {
        harness: "studio",
        id: "claude-opus-4-8",
        provider: "anthropic",
      },
      timing: { completedAt: 3, durationMs: 2, startedAt: 1 },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it("omits absent sections rather than emitting undefined keys", () => {
    expect(
      normalizeMessageMetadata({
        model: { id: "m" },
      })
    ).toEqual({ model: { id: "m" } });
  });
});
