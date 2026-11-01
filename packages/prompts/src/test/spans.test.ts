import { describe, expect, it } from "vitest";

import type { Span } from "../language";
import { SpanSet } from "../spans";

const SPAN_COUNT = 60;
const QUERY_COUNT = 400;
const TEXT_LENGTH = 40;
const MAX_WIDTH = 8;

/** A fixed sequence, so every run checks the same spans. */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state;
  };
}

function spansFrom(next: () => number, count: number): Span[] {
  return Array.from({ length: count }, () => {
    const start = next() % TEXT_LENGTH;
    return { end: start + (next() % MAX_WIDTH), start };
  });
}

describe("SpanSet", () => {
  it("answers overlap and containment as a pass over the spans would", () => {
    const next = sequence(7);
    const spans = spansFrom(next, SPAN_COUNT);
    const set = new SpanSet(spans);
    for (const query of spansFrom(next, QUERY_COUNT)) {
      expect(set.overlaps(query)).toBe(
        spans.some((span) => span.start < query.end && query.start < span.end)
      );
      expect(set.contains(query)).toBe(
        spans.some((span) => span.start <= query.start && query.end <= span.end)
      );
    }
  });

  it("holds nothing when empty", () => {
    const empty = new SpanSet([]);
    expect(empty.overlaps({ end: 1, start: 0 })).toBe(false);
    expect(empty.contains({ end: 0, start: 0 })).toBe(false);
  });
});
