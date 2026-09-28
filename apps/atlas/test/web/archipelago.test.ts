import { expect, it } from "vitest";

import { archipelagoCurve, archipelagoHull } from "../../src/web/archipelago";
import { insidePolygons } from "../../src/web/atmosphere";
import { loadAtlas } from "../helpers/reference-atlas";

it("keeps a closed, tangent-continuous Bezier rim outside the islands", async () => {
  const data = await loadAtlas();
  const curves = archipelagoCurve(archipelagoHull(data));
  expect(curves.length).toBeGreaterThan(24);
  const ring: [number, number][] = [];
  for (const [i, curve] of curves.entries()) {
    const next = curves[(i + 1) % curves.length];
    if (!next) {
      throw new Error("Missing adjoining curve");
    }
    expect(curve.end).toEqual(next.start);
    for (const axis of [0, 1] as const) {
      expect(curve.end[axis] - curve.second[axis]).toBeCloseTo(
        next.first[axis] - next.start[axis],
        8
      );
    }
    for (let sample = 0; sample < 24; sample += 1) {
      const t = sample / 24;
      const coordinate = (axis: 0 | 1) =>
        (1 - t) ** 3 * curve.start[axis] +
        3 * (1 - t) ** 2 * t * curve.first[axis] +
        3 * (1 - t) * t ** 2 * curve.second[axis] +
        t ** 3 * curve.end[axis];
      ring.push([coordinate(0), coordinate(1)]);
    }
  }
  for (const p of data.territories) {
    for (const polygon of p.coast) {
      for (const [x, y] of polygon[0] ?? []) {
        expect(insidePolygons({ x: p.x + x, y: p.y + y }, [[ring]])).toBe(true);
      }
    }
  }
});
