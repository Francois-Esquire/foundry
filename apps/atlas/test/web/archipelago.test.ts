import { expect, it } from "vitest";
import { insidePolygons } from "../../src/web/atmosphere";
import {
  archipelagoCurve,
  archipelagoHull,
} from "../../src/web/scene/archipelago";
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

it("smooths the rim into gentle bends with no sharp corners", async () => {
  const ring = archipelagoHull(await loadAtlas());
  const turns = ring.map((point, i) => {
    const before = ring[(i - 1 + ring.length) % ring.length] ?? point;
    const after = ring[(i + 1) % ring.length] ?? point;
    let turn =
      Math.atan2(after[1] - point[1], after[0] - point[0]) -
      Math.atan2(point[1] - before[1], point[0] - before[0]);
    turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
    return (turn * 180) / Math.PI;
  });
  for (const turn of turns) {
    expect(Math.abs(turn)).toBeLessThan(8);
  }
  expect(Math.abs(turns.reduce((sum, turn) => sum + turn, 0))).toBeCloseTo(
    360,
    3
  );
});
