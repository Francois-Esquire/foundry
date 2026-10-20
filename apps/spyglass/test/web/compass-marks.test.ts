import { expect, it } from "vitest";
import { inks } from "../../src/web/ladder/ink-ladder";
import { compassCentre } from "../../src/web/layout/compass";
import { compassMarks } from "../../src/web/layout/compass-marks";

it("draws the rose in map units at the chart's north-east corner: a circle, four filled points and four outlined", () => {
  const data = { height: 400, width: 900 };
  const { x, y } = compassCentre(data);
  const marks = compassMarks(data);
  const fills = marks.filter((mark) => mark.kind === "fill");
  const strokes = marks.filter((mark) => mark.kind === "stroke");
  expect(fills).toHaveLength(4);
  expect(strokes).toHaveLength(5);
  expect(marks.every((mark) => mark.colour === inks.compass)).toBe(true);
  expect(marks.every((mark) => mark.on === undefined)).toBe(true);
  const [circle] = strokes;
  // A closed circle of radius 23 about the centre.
  expect(circle?.points.slice(0, 2)).toEqual(circle?.points.slice(-2));
  expect(circle?.points[0]).toBeCloseTo(x + 23);
  expect(circle?.points[1]).toBeCloseTo(y);
  // The north point reaches 35 units up; the east one 35 units east.
  const [north, east] = fills;
  expect(north?.polygon[0]?.[0]).toEqual([x, y - 35]);
  expect(east?.polygon[0]?.[0]?.[0]).toBeCloseTo(x + 35);
  expect(east?.polygon[0]?.[0]?.[1]).toBeCloseTo(y);
  // The outlined points are closed rings at a fine pen.
  for (const point of strokes.slice(1)) {
    expect(point.points.slice(0, 2)).toEqual(point.points.slice(-2));
    expect(point.width).toBe(0.65);
  }
});
