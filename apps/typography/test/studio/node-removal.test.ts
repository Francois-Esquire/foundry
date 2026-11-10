import { describe, expect, it } from "vitest";
import { deleteNodes } from "~/studio/node-removal";
import type { Outline } from "~/typeface/outline";
import { editablePoints } from "~/typeface/outline-editing";
import { TRIANGLE } from "../helpers/fixtures";

const HEXAGON: Outline = {
  contours: [
    {
      segments: [
        { kind: "line", to: { x: 100, y: 0 } },
        { kind: "line", to: { x: 150, y: 80 } },
        { kind: "line", to: { x: 100, y: 160 } },
        { kind: "line", to: { x: 0, y: 160 } },
        { kind: "line", to: { x: -50, y: 80 } },
      ],
      start: { x: 0, y: 0 },
    },
  ],
};

const nodePoints = (outline: Outline) =>
  editablePoints(outline)
    .filter((point) => point.address.kind === "node")
    .map((point) => `${point.point.x},${point.point.y}`)
    .sort();

describe("deleting several nodes", () => {
  it("removes exactly the selected nodes, though each removal renumbers the rest", () => {
    const outline = deleteNodes(HEXAGON, [
      { contour: 0, kind: "node", node: 1 },
      { contour: 0, kind: "node", node: 4 },
    ]);
    expect(nodePoints(outline)).toEqual(
      ["0,0", "150,80", "100,160", "-50,80"].sort()
    );
  });

  it("removes a contour that is left too small, and keeps the others", () => {
    const outline = deleteNodes(
      {
        contours: [TRIANGLE.contours[0], HEXAGON.contours[0]].flatMap(
          (contour) => (contour ? [contour] : [])
        ),
      },
      [
        { contour: 0, kind: "node", node: 0 },
        { contour: 1, kind: "node", node: 2 },
      ]
    );
    expect(outline.contours).toHaveLength(1);
    expect(nodePoints(outline)).toHaveLength(5);
  });

  it("ignores handles and returns the same outline when no node is selected", () => {
    expect(
      deleteNodes(HEXAGON, [
        { contour: 0, kind: "handle", segment: 0, which: 0 },
      ])
    ).toBe(HEXAGON);
  });
});
