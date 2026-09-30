import { describe, expect, it } from "vitest";
import { paperThickness } from "../../src/web/scene/paper-material";
import {
  settlementColor,
  terrainGeometry,
  terrainHeight,
} from "../../src/web/scene/terrain";
import { loadAtlas } from "../helpers/reference-atlas";

describe("atlas terrain", () => {
  it("tapers continuous density relief to unchanged coastlines", async () => {
    const data = await loadAtlas();
    const p = data.territories.find(
      (territory) => territory.files.length > 100
    );
    if (!p) {
      throw new Error("Missing populated territory");
    }
    const before = structuredClone(p);
    for (const polygon of p.coast) {
      for (const ring of polygon) {
        for (const [x, y] of ring) {
          expect(terrainHeight(p, x, y)).toBeCloseTo(paperThickness, 5);
        }
      }
    }
    const [f] = p.files;
    const [polygon] = [...p.coast].sort(
      (a, b) => b.flat().length - a.flat().length
    );
    if (!(f && polygon)) {
      throw new Error("Missing file or coast");
    }
    expect(
      Math.abs(terrainHeight(p, f.x, f.y) - terrainHeight(p, f.x + 0.001, f.y))
    ).toBeLessThan(0.01);
    const geo = terrainGeometry(p, polygon, data.width, data.height);
    const positions = geo.getAttribute("position");
    const heights = Array.from({ length: positions.count }, (_, i) =>
      positions.getZ(i)
    );
    expect(heights.every(Number.isFinite)).toBe(true);
    expect(new Set(heights.map((z) => z.toFixed(2))).size).toBeGreaterThan(20);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(paperThickness - 0.001);
    expect(Math.max(...heights)).toBeLessThanOrEqual(paperThickness + 18.001);
    expect(p).toEqual(before);
    geo.dispose();
  });
  it("distinguishes canonical kinds and leaves unknown kinds neutral", () => {
    expect(
      new Set(
        ["source", "test", "story", "config", "other"].map(settlementColor)
      ).size
    ).toBe(5);
    expect(settlementColor("unknown")).toBe(settlementColor("other"));
  });
});
