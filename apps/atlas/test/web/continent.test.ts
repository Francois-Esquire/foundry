import { expect, it } from "vitest";

import { insidePolygons } from "../../src/web/atmosphere";
import {
  continentCell,
  continentCoasts,
  createContinents,
  forestSites,
  settlementBuildings,
  settlementKind,
} from "../../src/web/continent";
import { ecosystemOpacity } from "../../src/web/ecosystem-layer";
import { loadAtlas } from "../helpers/reference-atlas";

it("forms land from connected groups while retaining every original coastline at zero buffer", async () => {
  const data = await loadAtlas();
  const saved = structuredClone(data);
  const continents = createContinents(data, 0);
  const coasts = continentCoasts(data, continents);
  expect(continents.length).toBeGreaterThan(0);
  for (const c of continents) {
    expect(c.members.length).toBeGreaterThan(1);
    expect(
      c.field.filled.some(
        (value, i) =>
          value > 0 && (c.field.settlementDistance[i] ?? 0) * c.field.step > 40
      )
    ).toBe(true);
    for (const p of c.members) {
      for (const polygon of p.coast) {
        expect(coasts).toContainEqual(
          polygon.map((ring) => ring.map(([x, y]) => [x + p.x, y + p.y]))
        );
      }
    }
    const isolated = data.territories.filter((p) => !c.members.includes(p));
    for (const p of isolated) {
      expect(c.field.filled[continentCell(c, p.x, p.y)] ?? 0).toBe(0);
    }
  }
  expect(data).toEqual(saved);
});

it("places deterministic forests between settlements with shoreline clearance", async () => {
  const data = await loadAtlas();
  const c = createContinents(data, 0)[0];
  if (!c) {
    throw new Error("Missing continent");
  }
  const trees = forestSites(c);
  expect(trees.length).toBeGreaterThan(100);
  expect(trees).toEqual(forestSites(c));
  for (const tree of trees) {
    const i = continentCell(c, tree.x, tree.y);
    expect(c.field.filled[i]).toBe(1);
    expect((c.field.inland[i] ?? 0) * c.field.step).toBeGreaterThanOrEqual(14);
    expect(
      (c.field.settlementDistance[i] ?? 0) * c.field.step
    ).toBeGreaterThanOrEqual(20);
  }
});

it("uses file count for settlement scale and keeps building footprints inside package terrain", async () => {
  expect([0, 39, 40, 299, 300, 1000].map(settlementKind)).toEqual([
    "village",
    "village",
    "town",
    "town",
    "city",
    "city",
  ]);
  const data = await loadAtlas();
  for (const p of data.territories) {
    const buildings = settlementBuildings(p);
    expect(buildings).toEqual(settlementBuildings(p));
    expect(buildings.length).toBeLessThanOrEqual(64);
    for (const b of buildings) {
      for (const dx of [-1, 1]) {
        for (const dy of [-1, 1]) {
          expect(
            insidePolygons(
              { x: b.x + dx * b.size, y: b.y + dy * b.size },
              p.coast
            )
          ).toBe(true);
        }
      }
      for (const other of buildings) {
        if (other !== b) {
          expect(Math.hypot(b.x - other.x, b.y - other.y)).toBeGreaterThan(
            (b.size + other.size) * 0.6
          );
        }
      }
    }
  }
  expect(ecosystemOpacity(0.5)).toBe(1);
  expect(ecosystemOpacity(2)).toBeCloseTo(0.5);
  expect(ecosystemOpacity(4)).toBe(0);
});
