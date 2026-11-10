import { describe, expect, it } from "vitest";
import { harfBuzzReader } from "~/engines/harfbuzz/reader";
import { type Outline, outlineBounds, outlineToPath } from "~/typeface/outline";
import {
  addressKey,
  convertSegment,
  deleteContour,
  deleteNode,
  editablePoints,
  insertNode,
  movePoints,
  nearestPoint,
  nearestSegment,
  segmentEnds,
} from "~/typeface/outline-editing";
import { fontBytes, TRIANGLE } from "../helpers/fixtures";

/** A rounded shape: one line and two cubic curves. */
const LEAF: Outline = {
  contours: [
    {
      segments: [
        { kind: "line", to: { x: 100, y: 0 } },
        {
          control1: { x: 100, y: 60 },
          control2: { x: 60, y: 100 },
          kind: "cubic",
          to: { x: 0, y: 100 },
        },
        {
          control1: { x: -30, y: 100 },
          control2: { x: 0, y: 30 },
          kind: "cubic",
          to: { x: 0, y: 0 },
        },
      ],
      start: { x: 0, y: 0 },
    },
  ],
};

const node = (index: number, contour = 0) =>
  ({ contour, kind: "node", node: index }) as const;

describe("editablePoints", () => {
  it("lists a node for every corner, closing an open ring", () => {
    const points = editablePoints(TRIANGLE);
    expect(points.map((point) => point.address.kind)).toEqual([
      "node",
      "node",
      "node",
    ]);
    expect(points.map((point) => point.point)).toEqual([
      { x: 100, y: 0 },
      { x: 500, y: 700 },
      { x: 900, y: 0 },
    ]);
  });

  it("hangs each cubic handle from the node beside it", () => {
    const handles = editablePoints(LEAF).filter(
      (point) => point.address.kind === "handle"
    );
    expect(handles).toHaveLength(4);
    expect(handles[0]).toMatchObject({
      anchor: { x: 100, y: 0 },
      point: { x: 100, y: 60 },
    });
    expect(handles[1]).toMatchObject({
      anchor: { x: 0, y: 100 },
      point: { x: 60, y: 100 },
    });
    expect(
      new Set(editablePoints(LEAF).map((point) => addressKey(point.address)))
        .size
    ).toBe(7);
  });

  it("reads the points of a real glyph", () => {
    const face = harfBuzzReader.open(fontBytes("lato"));
    const { outline } = face.glyph(face.glyphForCharacter(0x61) ?? 0);
    const points = editablePoints(outline);
    expect(
      points.filter((point) => point.address.kind === "node").length
    ).toBeGreaterThan(10);
    expect(
      points.filter((point) => point.address.kind === "handle").length
    ).toBeGreaterThan(10);
  });
});

describe("movePoints", () => {
  it("moves the first node along with the segment that closes onto it", () => {
    const moved = movePoints(LEAF, [node(0)], 10, 5);
    expect(moved.contours[0]?.start).toEqual({ x: 10, y: 5 });
    expect(moved.contours[0]?.segments.at(-1)?.to).toEqual({ x: 10, y: 5 });
    expect(LEAF.contours[0]?.start).toEqual({ x: 0, y: 0 });
  });

  it("carries a node's cubic handles so the curve keeps its shape there", () => {
    const moved = movePoints(LEAF, [node(2)], 0, 20);
    const [, into, out] = moved.contours[0]?.segments ?? [];
    expect(into).toMatchObject({
      control1: { x: 100, y: 60 },
      control2: { x: 60, y: 120 },
      to: { x: 0, y: 120 },
    });
    expect(out).toMatchObject({
      control1: { x: -30, y: 120 },
      control2: { x: 0, y: 30 },
    });
  });

  it("moves a handle alone, and does not move a carried handle twice", () => {
    const handle = {
      contour: 0,
      kind: "handle",
      segment: 1,
      which: 1,
    } as const;
    const alone = movePoints(LEAF, [handle], 5, 0);
    expect(alone.contours[0]?.segments[1]).toMatchObject({
      control2: { x: 65, y: 100 },
      to: { x: 0, y: 100 },
    });
    const together = movePoints(LEAF, [node(2), handle], 5, 0);
    expect(together.contours[0]?.segments[1]).toMatchObject({
      control2: { x: 65, y: 100 },
      to: { x: 5, y: 100 },
    });
  });

  it("leaves a quadratic handle where it is when a node moves", () => {
    const face = harfBuzzReader.open(fontBytes("lato"));
    const { outline } = face.glyph(face.glyphForCharacter(0x6f) ?? 0);
    const moved = movePoints(outline, [node(1)], 30, 0);
    const before = editablePoints(outline).filter(
      (point) => point.address.kind === "handle"
    );
    const after = editablePoints(moved).filter(
      (point) => point.address.kind === "handle"
    );
    expect(after.map((point) => point.point)).toEqual(
      before.map((point) => point.point)
    );
  });
});

describe("adding and removing nodes", () => {
  it("adds a node on a curve without changing the shape", () => {
    const split = insertNode(LEAF, 0, 1, 0.5);
    expect(split.contours[0]?.segments).toHaveLength(4);
    expect(outlineBounds(split)).toEqual(outlineBounds(LEAF));
    expect(split.contours[0]?.segments[1]?.to).toEqual({ x: 72.5, y: 72.5 });
  });

  it("adds a node on the closing edge of an open ring", () => {
    const split = insertNode(TRIANGLE, 0, 2, 0.5);
    expect(outlineToPath(split)).toBe("M100 0L500 700L900 0L500 0L100 0Z");
  });

  it("removes a node and joins its neighbours with a curve", () => {
    const joined = deleteNode(LEAF, 0, 2);
    expect(joined.contours[0]?.segments).toHaveLength(2);
    expect(joined.contours[0]?.segments[0]).toEqual({
      control1: { x: 100, y: 60 },
      control2: { x: 0, y: 30 },
      kind: "cubic",
      to: { x: 0, y: 0 },
    });
  });

  it("removes the first node too, and drops a contour too small to enclose anything", () => {
    expect(deleteNode(LEAF, 0, 0).contours[0]?.segments).toHaveLength(2);
    expect(deleteNode(TRIANGLE, 0, 1).contours).toHaveLength(0);
    expect(deleteContour(LEAF, 0).contours).toHaveLength(0);
  });

  it("straightens a curve and bends a line", () => {
    expect(convertSegment(LEAF, 0, 1, "line").contours[0]?.segments[1]).toEqual(
      { kind: "line", to: { x: 0, y: 100 } }
    );
    const bent = convertSegment(LEAF, 0, 0, "cubic").contours[0]?.segments[0];
    expect(bent).toMatchObject({ kind: "cubic", to: { x: 100, y: 0 } });
    expect(outlineBounds(convertSegment(LEAF, 0, 0, "cubic"))).toEqual(
      outlineBounds(LEAF)
    );
  });
});

describe("hit testing", () => {
  it("finds the nearest point within reach, preferring a node", () => {
    expect(nearestPoint(LEAF, { x: 98, y: 3 }, 10)?.address).toEqual(node(1));
    expect(nearestPoint(LEAF, { x: 58, y: 97 }, 10)?.address).toMatchObject({
      kind: "handle",
      segment: 1,
      which: 1,
    });
    expect(nearestPoint(LEAF, { x: 400, y: 400 }, 10)).toBeUndefined();
  });

  it("finds the place on the outline nearest a position", () => {
    const hit = nearestSegment(LEAF, { x: 50, y: -8 });
    expect(hit).toMatchObject({
      contour: 0,
      point: { x: 50, y: 0 },
      segment: 0,
      t: 0.5,
    });
    expect(hit?.distance).toBe(8);
    expect(segmentEnds(LEAF, 0, 2)).toEqual({
      from: { x: 0, y: 100 },
      to: { x: 0, y: 0 },
    });
  });
});

describe("curve conversion and ties", () => {
  it("turns a quadratic curve into a cubic without changing its shape", () => {
    const arch: Outline = {
      contours: [
        {
          segments: [
            {
              control: { x: 50, y: 100 },
              kind: "quadratic",
              to: { x: 100, y: 0 },
            },
            { kind: "line", to: { x: 0, y: 0 } },
          ],
          start: { x: 0, y: 0 },
        },
      ],
    };
    const cubic = convertSegment(arch, 0, 0, "cubic");
    expect(cubic.contours[0]?.segments[0]?.kind).toBe("cubic");
    const before = outlineBounds(arch);
    const after = outlineBounds(cubic);
    // Both controls set to the quadratic's control would lift the arch from 50 to 75.
    expect(after?.yMax).toBeCloseTo(before?.yMax ?? 0, 9);
    expect(after?.xMax).toBeCloseTo(before?.xMax ?? 0, 9);
  });

  it("prefers a node over a handle at the same distance, across contours", () => {
    const twoContours: Outline = {
      contours: [
        {
          segments: [
            {
              control1: { x: 10, y: 0 },
              control2: { x: 90, y: 90 },
              kind: "cubic",
              to: { x: 100, y: 100 },
            },
            { kind: "line", to: { x: 0, y: 100 } },
            { kind: "line", to: { x: 0, y: 0 } },
          ],
          start: { x: 0, y: 0 },
        },
        {
          segments: [
            { kind: "line", to: { x: 60, y: 60 } },
            { kind: "line", to: { x: 30, y: 60 } },
          ],
          start: { x: 30, y: 0 },
        },
      ],
    };
    expect(nearestPoint(twoContours, { x: 20, y: 0 }, 15)?.address).toEqual(
      node(0, 1)
    );
  });
});
