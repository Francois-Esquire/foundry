import { expect, it } from "vitest";

import { insidePolygons } from "../../src/web/atmosphere";
import { paperThickness } from "../../src/web/scene/paper-material";
import { terrainHeight } from "../../src/web/scene/terrain";
import {
  archipelagoRings,
  coastalRings,
  landContours,
} from "../../src/web/scene/topography";
import { loadAtlas } from "../helpers/reference-atlas";

it("packs rings near the rim and increases spacing without extending their reach", () => {
  expect(coastalRings.at(-1)).toBe(20);
  expect(archipelagoRings.at(-1)).toBe(22);
  for (const rings of [coastalRings, archipelagoRings]) {
    expect(rings).toHaveLength(7);
    let previousGap = 0;
    for (let i = 1; i < rings.length; i += 1) {
      const gap = (rings[i] ?? 0) - (rings[i - 1] ?? 0);
      expect(gap).toBeGreaterThan(previousGap);
      previousGap = gap;
    }
  }
});

it("extracts contours from actual relief without changing geography", async () => {
  const data = await loadAtlas();
  const p = data.territories.find((territory) => territory.files.length > 500);
  if (!p) {
    throw new Error("Missing large island");
  }
  const before = structuredClone(p);
  const lines = landContours(p);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.some((line) => line.major)).toBe(true);
  for (const line of lines) {
    expect(line.points[0]).toEqual(line.points.at(-1));
    for (const [x, y] of line.points) {
      expect(insidePolygons({ x: x - p.x, y: y - p.y }, p.coast)).toBe(true);
      expect(
        Math.abs(
          terrainHeight(p, x - p.x, y - p.y) - paperThickness - line.elevation
        )
      ).toBeLessThan(0.5);
    }
  }
  expect(p).toEqual(before);
});
