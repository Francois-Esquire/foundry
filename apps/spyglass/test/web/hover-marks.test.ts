import { expect, it } from "vitest";
import type { Territory } from "../../src/web/data/types";
import { inkAlpha, inks } from "../../src/web/ladder/ink-ladder";
import { inkStyle } from "../../src/web/ladder/ink-table";
import { hoverMarks } from "../../src/web/layout/hover-marks";

const island = {
  coast: [
    [
      [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, -10],
      ],
    ],
  ],
  x: 100,
  y: 50,
} as unknown as Territory;

it("inks the hovered island's coast as a soft band under a line, draped on the island", () => {
  const marks = hoverMarks(island);
  expect(marks).toHaveLength(2);
  const [band, line] = marks;
  expect(band).toMatchObject({
    alpha: inkAlpha.hoverBand,
    colour: inks.hover,
    kind: "stroke",
    on: island,
    width: 6,
  });
  expect(line).toMatchObject({
    alpha: inkAlpha.hoverLine,
    colour: inks.hover,
    on: island,
    width: inkStyle("hover").weight,
  });
  expect(band?.points).toEqual([90, 40, 110, 40, 110, 60, 90, 40]);
  expect(line?.points).toBe(band?.points);
  // The same island hands the renderer the same polyline each hover.
  expect(hoverMarks(island)[0]?.points).toBe(band?.points);
});

it("draws nothing without a hovered island", () => {
  expect(hoverMarks(null)).toEqual([]);
});
