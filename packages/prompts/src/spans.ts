import type { Span } from "./language";

/**
 * A fixed set of spans, sorted by start with a running maximum of their
 * ends, so asking whether any of them overlaps or contains a span is a
 * binary search rather than a pass over the set. Exact for spans in any
 * order, nested or overlapping.
 */
export class SpanSet {
  private readonly starts: number[];
  /** `reach[i]`: the furthest end among the first `i + 1` spans by start. */
  private readonly reach: number[];

  constructor(spans: Iterable<Span>) {
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    this.starts = sorted.map((span) => span.start);
    this.reach = [];
    let furthest = Number.NEGATIVE_INFINITY;
    for (const span of sorted) {
      furthest = Math.max(furthest, span.end);
      this.reach.push(furthest);
    }
  }

  /** Some span shares at least one position with `span`. */
  overlaps(span: Span): boolean {
    const before = this.countStartingBefore(span.end, false);
    return before > 0 && (this.reach[before - 1] ?? 0) > span.start;
  }

  /** Some span starts at or before `span` and ends at or after it. */
  contains(span: Span): boolean {
    const before = this.countStartingBefore(span.start, true);
    return before > 0 && (this.reach[before - 1] ?? 0) >= span.end;
  }

  /** How many spans start before `offset`, or at it too when `inclusive`. */
  private countStartingBefore(offset: number, inclusive: boolean): number {
    let low = 0;
    let high = this.starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const start = this.starts[middle] ?? 0;
      if (start < offset || (inclusive && start === offset)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}
