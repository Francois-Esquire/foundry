import { expect, it } from "vitest";

import { spyglassBoundaries } from "../../src/web/layout/boundaries";
import {
  boundaryMarks,
  boundaryStyles,
} from "../../src/web/layout/boundary-marks";
import { defaultBoundaries } from "../../src/web/settings/boundary-settings";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("retains every computational boundary independently of layer visibility", async () => {
  const data = await loadSpyglass();
  const before = structuredClone(data.territories);
  const layers = spyglassBoundaries(data);
  expect(layers.outer).toHaveLength(1);
  expect(layers.groups.length).toBeGreaterThan(0);
  expect(layers.footprint.length).toBeGreaterThan(0);
  expect(layers.pockets.length).toBeGreaterThan(0);
  expect(layers.clearance).toHaveLength(data.territories.length);
  expect(layers.coasts.length).toBeGreaterThanOrEqual(data.territories.length);
  const hidden = {
    clearance: false,
    coasts: false,
    footprint: false,
    groups: false,
    outer: false,
    pockets: false,
  };
  expect(boundaryMarks(layers, hidden)).toEqual([]);
  for (const key of Object.keys(
    boundaryStyles
  ) as (keyof typeof boundaryStyles)[]) {
    const marks = boundaryMarks(layers, { ...hidden, [key]: true });
    expect(marks).toHaveLength(layers[key].length);
    const style = boundaryStyles[key];
    for (const mark of marks) {
      expect(mark.colour).toBe(style.color);
      expect(mark.dash ?? []).toEqual(style.dash);
      expect(mark.on).toBeUndefined();
      // A closed outline, flattened from the rim's curve.
      expect(mark.points.slice(0, 2)).toEqual(mark.points.slice(-2));
    }
    // The same outline hands the renderer the same polyline.
    expect(boundaryMarks(layers, { ...hidden, [key]: true })[0]?.points).toBe(
      marks[0]?.points
    );
  }
  // The pockets' dash-dot pattern has four entries.
  expect(boundaryStyles.pockets.dash).toHaveLength(4);
  expect(data.territories).toEqual(before);
  expect(defaultBoundaries).toEqual(hidden);
});
