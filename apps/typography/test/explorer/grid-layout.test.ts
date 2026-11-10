import { describe, expect, it } from "vitest";
import {
  columnsFor,
  type GridSection,
  layoutGrid,
  offsetOfCharacter,
  visibleWindows,
} from "~/explorer/grid-layout";

const METRICS = { columns: 10, gap: 20, headingHeight: 40, rowHeight: 50 };

const section = (key: string, first: number, count: number): GridSection => ({
  characters: Uint32Array.from({ length: count }, (_, index) => first + index),
  detail: "",
  key,
  title: key,
});

describe("columnsFor", () => {
  it("fits whole cells and never drops below one", () => {
    expect(columnsFor(560, 56)).toBe(10);
    expect(columnsFor(615, 56)).toBe(10);
    expect(columnsFor(616, 56)).toBe(11);
    expect(columnsFor(20, 56)).toBe(1);
  });
});

describe("layoutGrid", () => {
  it("stacks sections: heading, whole rows, then the gap", () => {
    const layout = layoutGrid(
      [section("a", 0x41, 25), section("b", 0x9_00, 10)],
      METRICS
    );
    expect(
      layout.sections.map(({ height, rows, top }) => ({ height, rows, top }))
    ).toEqual([
      { height: 40 + 3 * 50 + 20, rows: 3, top: 0 },
      { height: 40 + 50 + 20, rows: 1, top: 210 },
    ]);
    expect(layout.height).toBe(320);
  });

  it("has no height for no sections", () => {
    expect(layoutGrid([], METRICS).height).toBe(0);
  });
});

describe("visibleWindows", () => {
  const large = layoutGrid([section("han", 0x4e_00, 100_000)], METRICS);

  it("renders only the rows near the viewport of a very large section", () => {
    const [window] = visibleWindows(large, 250_000, 600, 2);
    expect(window?.firstRow).toBe(4997);
    expect(window?.endRow).toBe(5014);
    expect(window?.characters).toHaveLength(170);
    expect(window?.characters[0]).toBe(0x4e_00 + 4997 * 10);
  });

  it("starts at the first row and stops at the last", () => {
    const [top] = visibleWindows(large, 0, 600, 2);
    expect(top?.firstRow).toBe(0);
    const [bottom] = visibleWindows(large, large.height - 600, 600, 2);
    expect(bottom?.endRow).toBe(10_000);
    expect(bottom?.characters.at(-1)).toBe(0x4e_00 + 99_999);
  });

  it("skips sections above and below the viewport", () => {
    const layout = layoutGrid(
      [section("a", 0, 100), section("b", 1000, 100), section("c", 2000, 100)],
      METRICS
    );
    const windows = visibleWindows(layout, 700, 300, 0);
    expect(windows.map((window) => window.placed.section.key)).toEqual(["b"]);
    expect(windows[0]?.firstRow).toBe(2);
    expect(windows[0]?.endRow).toBe(8);
  });

  it("keeps a section whose heading alone is in view, with no rows cut wrongly", () => {
    const layout = layoutGrid(
      [section("a", 0, 10), section("b", 1000, 100)],
      METRICS
    );
    const windows = visibleWindows(layout, 0, 120, 0);
    expect(windows.map((window) => window.placed.section.key)).toEqual([
      "a",
      "b",
    ]);
    expect(windows[1]?.characters).toHaveLength(0);
  });
});

describe("offsetOfCharacter", () => {
  const layout = layoutGrid(
    [section("a", 0x41, 25), section("b", 0x9_00, 30)],
    METRICS
  );

  it("finds the top of the row that holds a character", () => {
    expect(offsetOfCharacter(layout, 0x41)).toBe(40);
    expect(offsetOfCharacter(layout, 0x41 + 24)).toBe(40 + 2 * 50);
    expect(offsetOfCharacter(layout, 0x9_15)).toBe(210 + 40 + 2 * 50);
  });

  it("has no offset for a character outside the grid", () => {
    expect(offsetOfCharacter(layout, 0x3_b1)).toBeUndefined();
  });
});
