import { expect, it } from "vitest";

import { continentCell, createContinents } from "../../src/web/continent";
import { createRoadNetwork } from "../../src/web/roads";
import { loadAtlas } from "../helpers/reference-atlas";

it("routes measured dependencies on land with shared corridors and stable evidence", async () => {
  const data = await loadAtlas();
  const before = structuredClone(data);
  const continents = createContinents(data, 0);
  const network = createRoadNetwork(data, continents);
  expect(network.routes.length).toBeGreaterThan(6);
  expect(network.routes).toEqual(
    createRoadNetwork(
      { ...data, routes: [...data.routes].reverse() },
      continents
    ).routes
  );
  expect(data).toEqual(before);
  let traversals = 0;
  for (const route of network.routes) {
    expect(data.routes).toContainEqual(route.dependency);
    const c = continents.find((c) =>
      c.members.some((p) => p.id === route.dependency.from)
    );
    if (!c) {
      throw new Error("Missing continent");
    }
    expect(c.members.some((p) => p.id === route.dependency.to)).toBe(true);
    traversals += route.points.length - 1;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1],
        b = route.points[i];
      if (!(a && b)) {
        throw new Error("Missing road point");
      }
      for (let n = 0; n <= 24; n++) {
        const index = continentCell(
          c,
          a.x + ((b.x - a.x) * n) / 24,
          a.y + ((b.y - a.y) * n) / 24
        );
        expect(c.field.filled[index]).toBe(1);
        expect(
          (c.field.inland[index] ?? 0) * c.field.step
        ).toBeGreaterThanOrEqual(6);
      }
    }
  }
  expect(network.segments.length).toBeLessThan(traversals);
  for (const path of network.paths) {
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1],
        b = path.points[i];
      if (!(a && b)) {
        continue;
      }
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      for (const side of [-1, 0, 1]) {
        for (let n = 0; n <= 4; n++) {
          const x =
            a.x + ((b.x - a.x) * n) / 4 - ((b.y - a.y) / length) * 1.7 * side;
          const y =
            a.y + ((b.y - a.y) * n) / 4 + ((b.x - a.x) / length) * 1.7 * side;
          expect(
            continents.some((c) => c.field.filled[continentCell(c, x, y)] === 1)
          ).toBe(true);
        }
      }
    }
  }
  expect(createRoadNetwork(data, []).routes).toEqual([]);
}, 30_000);

it("does not invent a water crossing when land is severed", async () => {
  const data = await loadAtlas();
  const continents = createContinents(data, 0);
  for (const c of continents) {
    c.field.filled.fill(0);
  }
  expect(createRoadNetwork(data, continents).routes).toEqual([]);
});
