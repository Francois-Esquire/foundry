import { expect, it } from "vitest";
import {
  continentCell,
  continentCoasts,
  createContinents,
} from "../../src/web/continent";
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
