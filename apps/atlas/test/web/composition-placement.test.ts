import { describe, expect, it } from "vitest";
import { layoutComposition } from "../../src/web/composition-layout";
import {
  compositionInsideLand,
  fitComposition,
} from "../../src/web/composition-placement";
import type { AtlasFile, Polygon } from "../../src/web/types";

const anchor: AtlasFile = {
  directory: "src",
  id: "file",
  incoming: 0,
  kind: "source",
  outgoing: 0,
  path: "src/file.ts",
  x: 0,
  y: 0,
};
const coast: Polygon[] = [
  [
    [
      [-20, -20],
      [20, -20],
      [20, 20],
      [-20, 20],
      [-20, -20],
    ],
    [
      [5, 5],
      [9, 5],
      [9, 9],
      [5, 9],
      [5, 5],
    ],
  ],
];
const marks = layoutComposition([
  {
    id: "local",
    symbols: Array.from({ length: 60 }, (_, index) => ({
      symbolId: `symbol:${index}`,
    })),
  },
]);

describe("local composition placement", () => {
  it("keeps mark footprints on land, outside holes and away from existing files", () => {
    const neighbor = { ...anchor, id: "neighbor", x: 1.8, y: 1.8 };
    const fitted = fitComposition(
      marks,
      { coast, files: [anchor, neighbor] },
      anchor
    );
    expect(fitted.unplaced).toEqual([]);
    for (const mark of fitted.marks) {
      for (const dx of [-0.8, 0.8]) {
        for (const dy of [-0.8, 0.8]) {
          expect(compositionInsideLand(mark.x + dx, mark.y + dy, coast)).toBe(
            true
          );
        }
      }
      expect(
        Math.hypot(mark.x - neighbor.x, mark.y - neighbor.y)
      ).toBeGreaterThanOrEqual(2.4);
    }
    expect(
      new Set(fitted.marks.map((mark) => `${mark.x}:${mark.y}`)).size
    ).toBe(marks.length);
  });
  it("is deterministic and never changes geography or identities", () => {
    const territory = { coast, files: [anchor] };
    const before = structuredClone({ marks, territory });
    expect(fitComposition([...marks].reverse(), territory, anchor)).toEqual(
      fitComposition(marks, territory, anchor)
    );
    expect({ marks, territory }).toEqual(before);
  });
  it("discloses every unplaced declaration when there is no capacity", () => {
    const fitted = fitComposition(
      marks,
      { coast: [], files: [anchor] },
      anchor
    );
    expect(fitted.marks).toEqual([]);
    expect(fitted.unplaced.sort()).toEqual(marks.map((mark) => mark.id).sort());
  });
  it("handles detached land and holes", () => {
    expect(compositionInsideLand(6, 6, coast)).toBe(false);
    expect(compositionInsideLand(-15, -15, coast)).toBe(true);
    expect(compositionInsideLand(30, 30, coast)).toBe(false);
  });
  it("reserves the current drawing when fitting a tracing-paper alternative", () => {
    const territory = { coast, files: [anchor] };
    const current = fitComposition(marks, territory, anchor);
    const proposed = fitComposition(marks, territory, anchor, current.marks);
    expect(proposed.unplaced).toEqual([]);
    for (const a of proposed.marks) {
      for (const b of current.marks) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(1.7);
      }
    }
  });
});
