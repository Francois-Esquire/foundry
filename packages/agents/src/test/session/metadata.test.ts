import { describe, expect, it } from "vitest";

import {
  normalizeMessageMetadata,
  normalizeUsage,
} from "../../session/metadata";
import { usage } from "../helpers/stream-parts";

describe("normalizeUsage", () => {
  it("keeps the token counts and drops absent details", () => {
    expect(
      normalizeUsage(
        usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
      )
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("reads absent counts as zero and derives a missing total", () => {
    expect(normalizeUsage(usage({ inputTokens: 3, outputTokens: 4 }))).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
    });
  });

  it("lifts cache and reasoning tokens out of the SDK's nested details", () => {
    expect(
      normalizeUsage(
        usage({
          cacheReadTokens: 8,
          cacheWriteTokens: 3,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 2,
          totalTokens: 15,
        })
      )
    ).toEqual({
      cachedInputTokens: 8,
      cacheWriteTokens: 3,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 15,
    });
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

  it("deep-picks the known usage fields a store row carries", () => {
    expect(
      normalizeMessageMetadata({
        usage: {
          cachedInputTokens: 8,
          inputTokens: 1,
          outputTokens: 1,
          // @ts-expect-error — a store row may carry fields outside the canonical shape
          somethingElse: 99,
          totalTokens: 2,
        },
      })?.usage
    ).toStrictEqual({
      cachedInputTokens: 8,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
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
