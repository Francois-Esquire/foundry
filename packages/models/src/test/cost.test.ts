import { describe, expect, it } from "vitest";

import { costFromUsage } from "../cost";

// Sonnet-class rates: $3/1M in, $15/1M out, $0.30/1M cache read, $3.75/1M write.
const RATES = { cachedInput: 0.3, cacheWrite: 3.75, input: 3, output: 15 };

describe("costFromUsage", () => {
  it("prices plain input + output", () => {
    const c = costFromUsage(RATES, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(c.input).toBeCloseTo(3);
    expect(c.total).toBeCloseTo(3);
  });

  it("treats inputTokens as gross — cache reads are split out, not double-charged", () => {
    // 4000 gross input, 3500 of it a cache read → 500 uncached.
    const c = costFromUsage(RATES, {
      cacheReadTokens: 3500,
      inputTokens: 4000,
      outputTokens: 63,
    });
    expect(c.input).toBeCloseTo((500 / 1e6) * 3);
    expect(c.cacheRead).toBeCloseTo((3500 / 1e6) * 0.3);
    expect(c.output).toBeCloseTo((63 / 1e6) * 15);
    expect(c.total).toBeCloseTo(c.input + c.output + c.cacheRead);
  });

  it("never goes negative when cache exceeds gross input", () => {
    const c = costFromUsage(RATES, {
      cacheReadTokens: 500,
      inputTokens: 100,
    });
    expect(c.input).toBe(0);
  });

  it("falls back to the input rate when a cache rate is absent", () => {
    const c = costFromUsage(
      { input: 3, output: 15 },
      { cacheReadTokens: 1000, inputTokens: 1000 }
    );
    // uncached = 0; cache read billed at the input rate (no cachedInput rate).
    expect(c.cacheRead).toBeCloseTo((1000 / 1e6) * 3);
  });

  it("bills reasoning at the output rate", () => {
    const c = costFromUsage(RATES, { reasoningTokens: 1_000_000 });
    expect(c.reasoning).toBeCloseTo(15);
  });

  // Qwen-3-max-thinking shape: input/output tiers share brackets keyed by the
  // gross prompt size. [0,32001)=$1.2/$6, [32001,128001)=$2.4/$12, [128001,∞)=$3/$15.
  const TIERED = {
    cachedInput: 0.24,
    input: 1.2,
    inputTiers: [
      { costPer1M: 1.2, maxTokens: 32_001, minTokens: 0 },
      { costPer1M: 2.4, maxTokens: 128_001, minTokens: 32_001 },
      { costPer1M: 3, minTokens: 128_001 },
    ],
    output: 6,
    outputTiers: [
      { costPer1M: 6, maxTokens: 32_001, minTokens: 0 },
      { costPer1M: 12, maxTokens: 128_001, minTokens: 32_001 },
      { costPer1M: 15, minTokens: 128_001 },
    ],
  };

  it("prices a tiered model at the lowest tier for a small prompt", () => {
    const c = costFromUsage(TIERED, {
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(c.input).toBeCloseTo((1000 / 1e6) * 1.2);
    expect(c.output).toBeCloseTo((1000 / 1e6) * 6);
  });

  it("selects the mid tier by gross prompt size and applies it to both input and output", () => {
    const c = costFromUsage(TIERED, {
      inputTokens: 100_000,
      outputTokens: 1000,
    });
    expect(c.input).toBeCloseTo((100_000 / 1e6) * 2.4);
    expect(c.output).toBeCloseTo((1000 / 1e6) * 12);
  });

  it("selects the open-ended top tier above the last bracket", () => {
    const c = costFromUsage(TIERED, {
      inputTokens: 200_000,
      outputTokens: 1000,
    });
    expect(c.input).toBeCloseTo((200_000 / 1e6) * 3);
    expect(c.output).toBeCloseTo((1000 / 1e6) * 15);
  });

  it("bills reasoning at the selected output tier", () => {
    const c = costFromUsage(TIERED, {
      inputTokens: 100_000,
      reasoningTokens: 1000,
    });
    expect(c.reasoning).toBeCloseTo((1000 / 1e6) * 12);
  });
});
