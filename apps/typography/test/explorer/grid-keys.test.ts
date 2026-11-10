import { describe, expect, it } from "vitest";
import { type CellPlace, crossSectionTarget } from "~/explorer/grid-keys";

/** A section of `count` cells laid out three to a row. */
const section = (count: number): CellPlace[] =>
  Array.from({ length: count }, (_, index) => ({
    left: (index % 3) * 56,
    top: Math.floor(index / 3) * 52,
  }));

const SECTIONS = [section(6), section(2), section(7)];

describe("crossSectionTarget", () => {
  it("leaves moves inside a section to the grid itself", () => {
    expect(
      crossSectionTarget(SECTIONS, { cell: 1, section: 0 }, "ArrowDown")
    ).toBeUndefined();
    expect(
      crossSectionTarget(SECTIONS, { cell: 4, section: 0 }, "ArrowRight")
    ).toBeUndefined();
    expect(
      crossSectionTarget(SECTIONS, { cell: 4, section: 2 }, "ArrowUp")
    ).toBeUndefined();
  });

  it("goes down from a section's last row into the same column of the next", () => {
    expect(
      crossSectionTarget(SECTIONS, { cell: 4, section: 0 }, "ArrowDown")
    ).toEqual({ cell: 1, section: 1 });
  });

  it("lands on the end of a row too short to have the column", () => {
    expect(
      crossSectionTarget(SECTIONS, { cell: 5, section: 0 }, "ArrowDown")
    ).toEqual({ cell: 1, section: 1 });
    expect(
      crossSectionTarget(SECTIONS, { cell: 2, section: 2 }, "ArrowUp")
    ).toEqual({ cell: 1, section: 1 });
  });

  it("goes up from a section's first row into the last row of the one before", () => {
    expect(
      crossSectionTarget(SECTIONS, { cell: 0, section: 1 }, "ArrowUp")
    ).toEqual({ cell: 3, section: 0 });
  });

  it("steps sideways across the boundary in reading order", () => {
    expect(
      crossSectionTarget(SECTIONS, { cell: 5, section: 0 }, "ArrowRight")
    ).toEqual({ cell: 0, section: 1 });
    expect(
      crossSectionTarget(SECTIONS, { cell: 0, section: 2 }, "ArrowLeft")
    ).toEqual({ cell: 1, section: 1 });
  });

  it("stays put at the ends of the grid and for other keys", () => {
    expect(
      crossSectionTarget(SECTIONS, { cell: 0, section: 0 }, "ArrowUp")
    ).toBeUndefined();
    expect(
      crossSectionTarget(SECTIONS, { cell: 6, section: 2 }, "ArrowDown")
    ).toBeUndefined();
    expect(
      crossSectionTarget(SECTIONS, { cell: 5, section: 0 }, "Enter")
    ).toBeUndefined();
  });
});
