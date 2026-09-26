import { expect, it } from "vitest";
import { insidePolygons } from "../../src/web/atmosphere";
import { shoreDistances } from "../../src/web/distance-field";
import {
  landmassFootprint,
  oceanAccess,
} from "../../src/web/landmass-footprint";
import {
  hullSeparation,
  landmassHull,
  packageGroups,
  relayoutAtlas,
  settleLandmasses,
} from "../../src/web/landmasses";
import type { AtlasRoute, Territory } from "../../src/web/types";
import { loadAtlas } from "../helpers/reference-atlas";

const island = (id: string, x: number, y: number): Territory => ({
  analyzed: true,
  coast: [
    [
      [
        [-20, -20],
        [20, -20],
        [20, 20],
        [-20, 20],
        [-20, -20],
      ],
    ],
  ],
  color: "#eee",
  files: [],
  hills: [],
  id,
  label: id,
  neighborhoods: [],
  radius: 20,
  shallows: [],
  x,
  y,
});
const routes: AtlasRoute[] = [
  { from: "a", sharedConcepts: 0, to: "b", weight: 1 },
  { from: "c", sharedConcepts: 0, to: "d", weight: 2 },
];

it("groups connected packages and retains singletons without inventing links", () => {
  const territories = [
    island("a", 0, 0),
    island("b", 0, 0),
    island("isolated", 0, 0),
  ];
  expect(
    packageGroups(territories, routes).map((g) => g.map((p) => p.id))
  ).toEqual([["a", "b"], ["isolated"]]);
  expect(
    packageGroups(
      territories,
      routes.map((r) => ({ ...r, weight: 0 }))
    ).map((g) => g.length)
  ).toEqual([1, 1, 1]);
});

it("separates crossing landmass hulls and an enclosed island without reshaping or rearranging members", () => {
  const territories = [
    island("a", -100, 0),
    island("b", 100, 0),
    island("c", 0, -100),
    island("d", 0, 100),
    island("isolated", 0, 0),
  ];
  const before = structuredClone(territories);
  settleLandmasses(territories, routes);
  const groups = packageGroups(territories, routes);
  for (const [i, group] of groups.entries()) {
    for (const other of groups.slice(i + 1)) {
      expect(
        hullSeparation(landmassHull(group), landmassHull(other), 44.9)
      ).toBeUndefined();
    }
  }
  for (const [i, p] of territories.entries()) {
    const original = before[i];
    expect({ ...p, x: 0, y: 0 }).toEqual({ ...original, x: 0, y: 0 });
  }
  for (const group of groups) {
    const first = group[0];
    if (!first) {
      continue;
    }
    const origin = before.find((p) => p.id === first.id);
    if (!origin) {
      throw new Error("Missing original member");
    }
    for (const p of group) {
      const old = before.find((t) => t.id === p.id);
      if (!old) {
        throw new Error("Missing original member");
      }
      expect(p.x - first.x).toBeCloseTo(old.x - origin.x, 6);
      expect(p.y - first.y).toBeCloseTo(old.y - origin.y, 6);
    }
  }
  const repeated = structuredClone(before).reverse();
  settleLandmasses(repeated, [...routes].reverse());
  expect(repeated.reverse()).toEqual(territories);
});

it("uses enclosing outermost-coast hulls rather than individual bubble envelopes", () => {
  const members = [
    island("a", -100, -100),
    island("b", -100, 100),
    island("c", 100, 100),
  ];
  const hull = landmassHull(members);
  expect(insidePolygons({ x: 0, y: 0 }, [[hull]])).toBe(true);
  for (const p of members) {
    for (const [x, y] of p.coast[0]?.[0] ?? []) {
      expect(insidePolygons({ x: p.x + x, y: p.y + y }, [[hull]])).toBe(true);
    }
  }
  expect(landmassHull([])).toEqual([]);
});

it("keeps unrelated coasts outside the actual concave footprint, allowing occupied convex-hull pockets", async () => {
  const data = await loadAtlas();
  const groups = packageGroups(
    data.territories,
    data.routes,
    data.declaredDependencies
  );
  for (const members of groups) {
    const rings =
      members.length > 1
        ? landmassFootprint(members).outline
        : [landmassHull(members)];
    const ids = new Set(members.map((p) => p.id));
    for (const p of data.territories) {
      for (const polygon of p.coast) {
        for (const [x, y] of polygon[0] ?? []) {
          expect(
            insidePolygons(
              { x: p.x + x, y: p.y + y },
              rings.map((r) => [r])
            ),
            p.id
          ).toBe(ids.has(p.id));
        }
      }
    }
  }
});

it("places a singleton in an open coastal bay without changing the mainland or island shape", () => {
  const mainland = [
    island("a", -300, -300),
    island("b", -300, 0),
    island("c", -300, 300),
    island("d", 0, 300),
    island("e", 300, 300),
    island("f", 300, 0),
    island("g", 300, -300),
  ];
  const links = mainland.slice(1).map((p, i) => ({
    from: mainland[i]?.id ?? "a",
    sharedConcepts: 0,
    to: p.id,
    weight: 1,
  }));
  const single = island("single", 0, 900);
  const territories = [...mainland, single];
  const original = structuredClone(territories);
  settleLandmasses(territories, links);
  const footprint = landmassFootprint(mainland);
  expect(insidePolygons(single, [[landmassHull(mainland)]])).toBe(true);
  expect(
    insidePolygons(
      single,
      footprint.outline.map((r) => [r])
    )
  ).toBe(false);
  const origin = footprint.point(0);
  const x = Math.round((single.x - origin.x) / footprint.step);
  const y = Math.round((single.y - origin.y) / footprint.step);
  const radius = Math.max(
    ...landmassHull([single]).map(([xx, yy]) =>
      Math.hypot(xx - single.x, yy - single.y)
    )
  );
  expect(
    (footprint.clearance[y * footprint.width + x] ?? 0) * footprint.step
  ).toBeGreaterThanOrEqual(radius + 45);
  const accessible = oceanAccess(
    Uint8Array.from(footprint.clearance, (d) =>
      d * footprint.step >= radius + 45 ? 1 : 0
    ),
    footprint.width,
    footprint.height
  );
  expect(accessible[y * footprint.width + x]).toBe(1);
  const reversed = structuredClone(original).reverse();
  settleLandmasses(reversed, [...links].reverse());
  expect(reversed.reverse()).toEqual(territories);
  expect(single.coast).toEqual(original.at(-1)?.coast);
});

it("does not classify enclosed holes as ocean-accessible pockets", () => {
  const open = new Uint8Array(49).fill(1);
  for (let y = 1; y <= 5; y++) {
    for (let x = 1; x <= 5; x++) {
      if (x === 1 || x === 5 || y === 1 || y === 5) {
        open[y * 7 + x] = 0;
      }
    }
  }
  const reached = oceanAccess(open, 7, 7);
  expect(reached[0]).toBe(1);
  expect(reached[24]).toBe(0);
  open[3] = 1;
  open[10] = 1;
  expect(oceanAccess(open, 7, 7)[24]).toBe(1);
});

it("augments analyzed groups with declared dependencies without changing module trade counts", () => {
  const territories = [
    island("a", 0, 0),
    island("b", 0, 0),
    island("config", 0, 0),
    island("isolated", 0, 0),
  ];
  const measured = [{ from: "a", sharedConcepts: 0, to: "b", weight: 3 }];
  const declared = [
    { from: "b", kind: "devDependencies" as const, to: "config" },
  ];
  expect(
    packageGroups(territories, measured, declared).map((g) =>
      g.map((p) => p.id)
    )
  ).toEqual([["a", "b", "config"], ["isolated"]]);
  expect(measured).toEqual([
    { from: "a", sharedConcepts: 0, to: "b", weight: 3 },
  ]);
});

it("centers the main continent and distributes outlying groups around it instead of retaining a bottom row", () => {
  const territories = [
    island("a", -100, 0),
    island("b", 100, 0),
    island("one", -300, 400),
    island("two", 0, 400),
    island("three", 300, 400),
  ];
  const links = [{ from: "a", sharedConcepts: 0, to: "b", weight: 2 }];
  settleLandmasses(territories, links);
  const groups = packageGroups(territories, links);
  const main = groups.find((g) => g.length === 2) ?? [];
  const hull = landmassHull(main);
  expect(
    Math.min(...hull.map(([x]) => x)) + Math.max(...hull.map(([x]) => x))
  ).toBeCloseTo(0, 6);
  expect(
    Math.min(...hull.map(([, y]) => y)) + Math.max(...hull.map(([, y]) => y))
  ).toBeCloseTo(0, 6);
  const outside = territories.filter((p) => p.id !== "a" && p.id !== "b");
  expect(outside.some((p) => p.y < 0)).toBe(true);
  expect(outside.some((p) => p.x < 0)).toBe(true);
  expect(outside.some((p) => p.x > 0)).toBe(true);
});

it("includes the real shared ESLint config in Studio's landmass", async () => {
  const data = await loadAtlas();
  const main = packageGroups(
    data.territories,
    data.routes,
    data.declaredDependencies
  ).find((g) => g.some((p) => p.id === "@foundry/studio"));
  expect(main?.some((p) => p.id === "@foundry/eslint-config")).toBe(true);
  expect(data.declaredDependencies).toContainEqual({
    from: "@foundry/studio",
    kind: "devDependencies",
    to: "@foundry/eslint-config",
  });
});

it("applies live layout settings while preserving geometry and placing islands near pockets", async () => {
  const original = await loadAtlas();
  const saved = structuredClone(original);
  const placements: number[][] = [];
  for (const settings of [
    { coastalBuffer: 8, islandClearance: 8 },
    { coastalBuffer: 64, islandClearance: 80 },
  ]) {
    const data = relayoutAtlas(original, settings);
    expect(relayoutAtlas(original, settings)).toEqual(data);
    const groups = packageGroups(
      data.territories,
      data.routes,
      data.declaredDependencies
    );
    const main = groups.find((g) => g.length > 1) ?? [];
    const singles = groups.filter((g) => g.length === 1).flat();
    const field = landmassFootprint(main, settings.coastalBuffer);
    const distances = shoreDistances(field.pockets, field.width, field.height);
    const start = field.point(0);
    placements.push(singles.flatMap((p) => [p.x, p.y]));
    for (const p of singles) {
      const x = Math.round((p.x - start.x) / field.step),
        y = Math.round((p.y - start.y) / field.step);
      const i = y * field.width + x;
      const radius = Math.max(
        ...landmassHull([p]).map(([xx, yy]) => Math.hypot(xx - p.x, yy - p.y))
      );
      expect((field.clearance[i] ?? 0) * field.step).toBeGreaterThanOrEqual(
        radius + settings.islandClearance
      );
      expect(
        (distances[i] ?? Number.POSITIVE_INFINITY) * field.step
      ).toBeLessThanOrEqual(radius + 120);
    }
    for (const p of data.territories) {
      const source = original.territories.find((t) => t.id === p.id);
      expect({ ...p, x: 0, y: 0 }).toEqual({ ...source, x: 0, y: 0 });
    }
    if (singles[0] && singles[1]) {
      expect(
        hullSeparation(
          landmassHull([singles[0]]),
          landmassHull([singles[1]]),
          settings.islandClearance - 0.1
        )
      ).toBeUndefined();
    }
  }
  expect(placements[0]).not.toEqual(placements[1]);
  expect(original).toEqual(saved);
});
