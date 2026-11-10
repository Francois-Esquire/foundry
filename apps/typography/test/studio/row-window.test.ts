import { describe, expect, it } from "vitest";
import { rowWindow, scrollToRow } from "~/studio/row-window";

const LIST = { count: 3023, rowHeight: 40, viewportHeight: 400 };

describe("the window on a long list", () => {
  it("renders the rows on screen and a few either side", () => {
    expect(rowWindow({ ...LIST, overscan: 2, scrollTop: 4000 })).toEqual({
      first: 98,
      last: 112,
      offset: 3920,
      totalHeight: 120_920,
    });
  });

  it("starts at the first row", () => {
    const top = rowWindow({ ...LIST, scrollTop: 0 });
    expect(top.first).toBe(0);
    expect(top.offset).toBe(0);
  });

  it("stops at the last row, even when scrolled past the end", () => {
    const end = rowWindow({ ...LIST, scrollTop: 10_000_000 });
    expect(end.last).toBe(3023);
    expect(end.first).toBeGreaterThan(3000);
  });

  it("renders every row of a short list", () => {
    expect(rowWindow({ ...LIST, count: 3, scrollTop: 0 })).toMatchObject({
      first: 0,
      last: 3,
    });
  });

  it("scrolls only as far as it takes to bring a row into view", () => {
    const view = { rowHeight: 40, scrollTop: 400, viewportHeight: 400 };
    expect(scrollToRow(12, view)).toBe(400);
    expect(scrollToRow(5, view)).toBe(200);
    expect(scrollToRow(30, view)).toBe(840);
  });
});
