export class SpanSet {
  private readonly starts: number[];
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

  overlaps(span: Span): boolean {
    const before = this.countStartingBefore(span.end, false);
    return before > 0 && (this.reach[before - 1] ?? 0) > span.start;
  }

  contains(span: Span): boolean {
    const before = this.countStartingBefore(span.start, true);
    return before > 0 && (this.reach[before - 1] ?? 0) >= span.end;
  }

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

export interface Span {
  readonly end: number;
  readonly start: number;
}
