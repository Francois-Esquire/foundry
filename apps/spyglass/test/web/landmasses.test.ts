import { expect, it } from "vitest";
import type { SpyglassRoute, Territory } from "../../src/web/data/types";
import {
  landmassFootprint,
  oceanAccess,
} from "../../src/web/landmass-footprint";
import { landmassHull } from "../../src/web/landmass-hull";
import { packageGroups } from "../../src/web/landmasses";
import { insidePolygons } from "../../src/web/polygons";
import { loadSpyglass } from "../helpers/reference-spyglass";

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
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id,
  label: id,
  radius: 20,
  responsibilityGroups: undefined,
  shallows: [],
  x,
  y,
});
const routes: SpyglassRoute[] = [
  {
    consumerFiles: [],
    from: "a",
    sharedConcepts: 0,
    supplierFiles: [],
    to: "b",
    weight: 1,
  },
  {
    consumerFiles: [],
    from: "c",
    sharedConcepts: 0,
    supplierFiles: [],
    to: "d",
    weight: 2,
  },
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
  const data = await loadSpyglass();
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

it("does not classify enclosed holes as ocean-accessible pockets", () => {
  const open = new Uint8Array(49).fill(1);
  for (let y = 1; y <= 5; y += 1) {
    for (let x = 1; x <= 5; x += 1) {
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
  const measured = [
    {
      consumerFiles: [],
      from: "a",
      sharedConcepts: 0,
      supplierFiles: [],
      to: "b",
      weight: 3,
    },
  ];
  const declared = [
    { from: "b", kind: "devDependencies" as const, to: "config" },
  ];
  expect(
    packageGroups(territories, measured, declared).map((g) =>
      g.map((p) => p.id)
    )
  ).toEqual([["a", "b", "config"], ["isolated"]]);
  expect(measured).toEqual([
    {
      consumerFiles: [],
      from: "a",
      sharedConcepts: 0,
      supplierFiles: [],
      to: "b",
      weight: 3,
    },
  ]);
});

it("includes the shared library in Spyglass's landmass", async () => {
  const data = await loadSpyglass();
  const main = packageGroups(
    data.territories,
    data.routes,
    data.declaredDependencies
  ).find((g) => g.some((p) => p.id === "@foundry/spyglass"));
  expect(main?.some((p) => p.id === "@foundry/lib")).toBe(true);
  expect(data.declaredDependencies).toContainEqual({
    from: "@foundry/spyglass",
    kind: "devDependencies",
    to: "@foundry/lib",
  });
});
