import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  isSelected,
  keepExisting,
  pointsInBox,
  pointsInOrder,
  type Selection,
  segmentsOf,
  selectAll,
  selectedTogether,
  selectionKey,
  stepSelection,
  toggleSelected,
} from "~/studio/selection";
import type { Outline } from "~/typeface/outline";
import type { PointAddress } from "~/typeface/outline-editing";
import { TRIANGLE } from "../helpers/fixtures";

const node = (index: number, contour = 0): PointAddress => ({
  contour,
  kind: "node",
  node: index,
});

const handle = (segment: number, which: 0 | 1 = 0): PointAddress => ({
  contour: 0,
  kind: "handle",
  segment,
  which,
});

/** A square whose top edge is a cubic curve: four nodes and two handles. */
const ARCH: Outline = {
  contours: [
    {
      segments: [
        { kind: "line", to: { x: 0, y: 100 } },
        {
          control1: { x: 30, y: 160 },
          control2: { x: 70, y: 160 },
          kind: "cubic",
          to: { x: 100, y: 100 },
        },
        { kind: "line", to: { x: 100, y: 0 } },
        { kind: "line", to: { x: 0, y: 0 } },
      ],
      start: { x: 0, y: 0 },
    },
  ],
};

describe("selection", () => {
  it("toggles a point in and out", () => {
    const one = toggleSelected(EMPTY_SELECTION, node(1));
    expect(isSelected(one, node(1))).toBe(true);
    expect(toggleSelected(one, node(1))).toEqual([]);
  });

  it("names a selection the same whatever order it was made in", () => {
    expect(selectionKey([node(2), node(0)])).toBe(
      selectionKey([node(0), node(2)])
    );
  });

  it("walks the points as a pen meets them: a node, then the handles after it", () => {
    expect(pointsInOrder(ARCH).map((point) => point.address)).toEqual([
      node(0),
      node(1),
      handle(1, 0),
      handle(1, 1),
      node(2),
      node(3),
    ]);
  });

  it("selects the points inside a box, whichever corner the drag began at", () => {
    const box = pointsInBox(ARCH, { x: 110, y: 170 }, { x: 60, y: 90 });
    expect(box).toEqual([handle(1, 1), node(2)]);
  });

  it("adds a box to what was selected without repeating a point", () => {
    expect(selectedTogether([node(2)], [handle(1, 1), node(2)])).toEqual([
      node(2),
      handle(1, 1),
    ]);
  });

  it("selects every point", () => {
    expect(selectAll(TRIANGLE)).toHaveLength(3);
  });

  it("drops points the outline no longer has", () => {
    const selection: Selection = [node(1), node(7), handle(1, 0)];
    expect(keepExisting(TRIANGLE, selection)).toEqual([node(1)]);
  });

  it("returns the same selection when every point still exists", () => {
    const selection: Selection = [node(1), node(2)];
    expect(keepExisting(TRIANGLE, selection)).toBe(selection);
  });

  describe("stepping from the keyboard", () => {
    it("starts at the first point, or the last when stepping back", () => {
      expect(stepSelection(ARCH, EMPTY_SELECTION, 1)).toEqual([node(0)]);
      expect(stepSelection(ARCH, EMPTY_SELECTION, -1)).toEqual([node(3)]);
    });

    it("moves on from the point selected last and wraps round", () => {
      expect(stepSelection(ARCH, [node(1)], 1)).toEqual([handle(1, 0)]);
      expect(stepSelection(ARCH, [node(3)], 1)).toEqual([node(0)]);
      expect(stepSelection(ARCH, [node(0)], -1)).toEqual([node(3)]);
    });

    it("keeps what was selected when extending", () => {
      expect(stepSelection(ARCH, [node(1)], 1, true)).toEqual([
        node(1),
        handle(1, 0),
      ]);
    });

    it("selects nothing in an empty outline", () => {
      expect(stepSelection({ contours: [] }, EMPTY_SELECTION, 1)).toEqual([]);
    });
  });

  describe("the segments a selection stands for", () => {
    it("is the segment between two selected neighbours", () => {
      expect(segmentsOf(ARCH, [node(1), node(2)])).toEqual([
        { contour: 0, segment: 1 },
      ]);
    });

    it("includes the closing segment, from the last node back to the first", () => {
      expect(segmentsOf(ARCH, [node(3), node(0)])).toEqual([
        { contour: 0, segment: 3 },
      ]);
    });

    it("is the segment a selected handle belongs to", () => {
      expect(segmentsOf(ARCH, [handle(1, 1)])).toEqual([
        { contour: 0, segment: 1 },
      ]);
    });

    it("is the segment that leaves a node selected alone", () => {
      expect(segmentsOf(ARCH, [node(2)])).toEqual([{ contour: 0, segment: 2 }]);
    });

    it("is nothing for nodes that are not neighbours", () => {
      expect(segmentsOf(ARCH, [node(0), node(2)])).toEqual([]);
    });
  });
});
