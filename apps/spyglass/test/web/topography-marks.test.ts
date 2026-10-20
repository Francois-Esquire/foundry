import { expect, it } from "vitest";
import type { Territory } from "../../src/web/data/types";
import { inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import { alphaAt } from "../../src/web/layout/marks";
import type { ContourLine } from "../../src/web/layout/topography";
import { topographyMarks } from "../../src/web/layout/topography-marks";

const island = { id: "island", x: 10, y: 20 } as Territory;

const lines: ContourLine[] = [
  {
    elevation: 2,
    major: false,
    on: island,
    opacity: 1,
    points: [
      [0, 0],
      [5, 0],
      [5, 5],
    ],
    sea: false,
  },
  {
    elevation: 4,
    major: true,
    on: island,
    opacity: 1,
    points: [
      [1, 1],
      [2, 2],
    ],
    sea: false,
  },
  {
    elevation: 0,
    major: true,
    opacity: 0.7,
    points: [
      [-50, -50],
      [50, -50],
    ],
    sea: true,
  },
  {
    elevation: 0,
    major: false,
    opacity: 0.4,
    points: [
      [-60, -60],
      [60, -60],
    ],
    sea: true,
  },
];

it("drapes land contours on their island and lays sea rings flat, in the contour inks and widths", () => {
  const marks = topographyMarks(lines, false);
  expect(marks).toHaveLength(4);
  expect(marks.map((mark) => mark.on)).toEqual([
    island,
    island,
    undefined,
    undefined,
  ]);
  expect(marks.map((mark) => mark.colour)).toEqual([
    inks.landContour,
    inks.landContour,
    inks.seaContour,
    inks.seaContour,
  ]);
  expect(marks.map((mark) => mark.width)).toEqual([0.45, 0.7, 0.7, 0.45]);
  expect(marks[0]?.points).toEqual([0, 0, 5, 0, 5, 5]);
  // The same contour hands the renderer the same polyline.
  expect(topographyMarks(lines, false)[0]?.points).toBe(marks[0]?.points);
});

it("fades minor contours in past overview and folds each ring's opacity into its alpha", () => {
  const [minorLand, majorLand, majorSea, minorSea] = topographyMarks(
    lines,
    false
  );
  expect(alphaAt(minorLand?.alpha ?? 0, 1)).toBe(0);
  expect(alphaAt(minorLand?.alpha ?? 0, 2.3)).toBeCloseTo(
    inkAlpha.landContourMinor
  );
  expect(alphaAt(majorLand?.alpha ?? 0, 1)).toBeCloseTo(
    inkAlpha.landContourMajor
  );
  expect(alphaAt(majorSea?.alpha ?? 0, 1)).toBeCloseTo(
    0.7 * inkAlpha.seaContourMajor
  );
  expect(alphaAt(minorSea?.alpha ?? 0, 1.7)).toBeCloseTo(
    0.5 * 0.4 * inkAlpha.seaContourMinor
  );
  // Lines that share a strength share one alpha function, so they batch.
  const twice = topographyMarks([...lines, ...lines], false);
  expect(twice[4]?.alpha).toBe(twice[0]?.alpha);
  expect(twice[0]?.alpha).not.toBe(twice[1]?.alpha);
});

it("veils the contours while a composition is drawn, at its zoom", () => {
  const [, majorLand] = topographyMarks(lines, true);
  expect(alphaAt(majorLand?.alpha ?? 0, 1)).toBeCloseTo(
    inkAlpha.landContourMajor
  );
  expect(alphaAt(majorLand?.alpha ?? 0, 8)).toBeCloseTo(
    0.2 * inkAlpha.landContourMajor
  );
});
