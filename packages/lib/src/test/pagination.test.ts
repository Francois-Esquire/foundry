import { describe, expect, it } from "vitest";

import {
  buildPage,
  collectPages,
  emptyPage,
  pageAfter,
  pageFromRows,
  pageLimit,
  sliceRanked,
} from "../pagination";

describe("pagination", () => {
  it("traverses every continuation once", async () => {
    const cursors: (number | undefined)[] = [];
    const items = await collectPages((cursor: number | undefined) => {
      cursors.push(cursor);
      return Promise.resolve(sliceRanked([1, 2, 3, 4, 5], 2, cursor ?? 0));
    });
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(cursors).toEqual([undefined, 2, 4]);
  });
  it("defaults and caps limits; rejects invalid requests", () => {
    expect(pageLimit(undefined)).toBe(50);
    expect(pageLimit(500)).toBe(200);
    expect(pageLimit(undefined, { fallback: 10 })).toBe(10);
    expect(pageLimit(500, { max: 100 })).toBe(100);
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => pageLimit(value)).toThrow(RangeError);
    }
  });

  it("preserves the complete total across middle, last and empty pages", () => {
    const values = [1, 2, 3, 4, 5];
    expect(sliceRanked(values, 2, 2)).toEqual({
      items: [3, 4],
      nextCursor: 4,
      total: 5,
    });
    expect(sliceRanked(values, 2, 4)).toEqual({ items: [5], total: 5 });
    expect(sliceRanked(values, 2, 10)).toEqual({ items: [], total: 5 });
    expect(emptyPage()).toEqual({ items: [], total: 0 });
  });

  it("hydrates only the requested rows and uses the supplied filtered count", () => {
    const visited: number[] = [];
    expect(
      buildPage([1, 2, 3], 2, 4, 12, (value) => {
        visited.push(value);
        return { value };
      })
    ).toEqual({
      items: [{ value: 1 }, { value: 2 }],
      nextCursor: 6,
      total: 12,
    });
    expect(visited).toEqual([1, 2]);
  });

  it("retains a query-specific cursor without changing the total", () => {
    const rows = [{ id: "b" }, { id: "c" }];
    expect(pageFromRows(rows, 1, 3, (row) => ({ id: row.id }))).toEqual({
      items: [rows[0]],
      nextCursor: { id: "b" },
      total: 3,
    });
    expect(
      pageAfter(["a", "b", "c"], { cursor: "a", limit: 1 }, (value) => value)
    ).toEqual({ items: ["b"], nextCursor: "b", total: 3 });
    expect(pageAfter(["a", "b"], { cursor: "b" }, (value) => value)).toEqual({
      items: [],
      total: 2,
    });
    expect(() =>
      pageAfter(["a"], { cursor: "missing" }, (value) => value)
    ).toThrow(RangeError);
  });
});
