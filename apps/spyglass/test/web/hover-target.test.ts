import { expect, it } from "vitest";
import type { Territory } from "../../src/web/data/types";
import {
  createHoverTarget,
  hoveredIsland,
  type PagePoint,
} from "../../src/web/scene/hover-target";

/** A camera's hit test: which island lies under each page point. */
const camera =
  (islands: Record<string, string>) =>
  ({ clientX, clientY }: PagePoint) =>
    islands[`${clientX},${clientY}`];

it("keeps the island under a still pointer through a wheel zoom toward it", () => {
  const target = createHoverTarget();
  target.move({ clientX: 40, clientY: 30 });
  expect(target.island(camera({ "40,30": "core" }))).toBe("core");
  // Zooming toward the cursor keeps the same island under it.
  expect(target.island(camera({ "40,30": "core", "90,30": "lib" }))).toBe(
    "core"
  );
});

it("follows the camera to the island now under the pointer, or none", () => {
  const target = createHoverTarget();
  target.move({ clientX: 40, clientY: 30 });
  expect(target.island(camera({ "40,30": "core" }))).toBe("core");
  // Escape or a header zoom moves the camera; the pointer has not moved.
  expect(target.island(camera({ "40,30": "lib" }))).toBe("lib");
  expect(target.island(camera({}))).toBeNull();
});

it("drops the hover when the pointer leaves the map", () => {
  const target = createHoverTarget();
  target.move({ clientX: 40, clientY: 30 });
  target.leave();
  expect(target.island(camera({ "40,30": "core" }))).toBeNull();
});

it("inks the island as the repaint lays it out, and never the selection", () => {
  const before = { id: "core", x: 0 } as Territory;
  const after = { id: "core", x: 120 } as Territory;
  expect(hoveredIsland("core", [after], null)).toBe(after);
  expect(hoveredIsland("core", [before], "core")).toBeNull();
  expect(hoveredIsland("gone", [after], null)).toBeNull();
  expect(hoveredIsland(null, [after], null)).toBeNull();
});
