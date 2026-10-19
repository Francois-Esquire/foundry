import { describe, expect, it } from "vitest";
import {
  qualifySpyglassData,
  type SpyglassData,
  type SpyglassFoundation,
  type Territory,
} from "../../src/web/data/types";
import { composeCollection } from "../../src/web/layout/collection";
import {
  createFoundationAttraction,
  positionFoundations,
} from "../../src/web/layout/foundations";
import {
  relayoutSpyglass,
  settlePackages,
} from "../../src/web/layout/geography";
import { loadSpyglass } from "../helpers/reference-spyglass";

const territory = (id: string): Territory => ({
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id,
  label: id,
  radius: 40,
  responsibilityGroups: undefined,
  shallows: [],
  x: 0,
  y: 0,
});
const foundation = (ids: string[], name = "shared"): SpyglassFoundation => ({
  id: `dependency:${name}`,
  lobes: [],
  members: ids.map((territoryId) => ({
    direct: true,
    distance: 1,
    territoryId,
    weight: 1,
  })),
  name,
  prominence: ids.length,
  versions: ["1.0.0"],
  x: 0,
  y: 0,
});
const positions = (territories: Territory[]) =>
  [...territories]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, x, y }) => ({ id, x, y }));

function lobesFollowIslands(data: SpyglassData): boolean {
  return (data.foundations ?? []).every((field) =>
    field.lobes.every((lobe) => {
      const island = data.territories.find(
        (item) => item.id === lobe.territoryId
      );
      return island?.x === lobe.x && island.y === lobe.y;
    })
  );
}

describe("foundation-influenced geography", () => {
  it("bounds attraction even when many ubiquitous foundations overlap", () => {
    const islands = [territory("a"), territory("b"), territory("c")];
    const [first, , last] = islands;
    if (first && last) {
      first.x = -10_000;
      last.x = 10_000;
    }
    const fields = Array.from({ length: 200 }, (_, index) =>
      foundation(["a", "b", "c"], String(index))
    );
    const before = islands.map(({ x, y }) => ({ x, y }));
    const field = createFoundationAttraction(fields, islands, 1);
    field.apply();
    for (const [index, island] of islands.entries()) {
      const origin = before[index];
      expect(origin).toBeDefined();
      expect(
        Math.hypot(island.x - (origin?.x ?? 0), island.y - (origin?.y ?? 0))
      ).toBeLessThanOrEqual(3);
    }
    expect(field.connected.size).toBe(3);
    expect(
      createFoundationAttraction([foundation(["a"])], islands, 1).connected.size
    ).toBe(0);
  });
  it("preserves the legacy layout exactly when influence is zero", () => {
    const islands = [territory("a"), territory("b"), territory("c")];
    const off = structuredClone(islands);
    const routes = [{ from: "a", to: "b", weight: 3 }];
    settlePackages(islands, { a: 1 }, 45, routes);
    settlePackages(off, { a: 1 }, 45, routes, [foundation(["a", "b", "c"])], 0);
    expect(off).toEqual(islands);
  });
  it("joins formerly offshore shared consumers without coast collisions and settles deterministically", () => {
    const islands = [
      territory("alpha"),
      territory("beta"),
      territory("gamma"),
      territory("alone"),
    ];
    const fields = [
      foundation(["alpha", "beta"]),
      foundation(["beta", "gamma"], "second"),
    ];
    const before = structuredClone(islands);
    settlePackages(before, {}, 45);
    settlePackages(islands, {}, 45, [], fields);
    expect(positions(islands)).not.toEqual(positions(before));
    const reordered = structuredClone(islands).reverse();
    settlePackages(reordered, {}, 45, [], structuredClone(fields).reverse());
    expect(positions(reordered)).toEqual(positions(islands));
    for (const [i, a] of islands.entries()) {
      for (const b of islands.slice(i + 1)) {
        expect(
          Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius - 64
        ).toBeGreaterThanOrEqual(54.999);
      }
    }
  });
  it("retains deterministic joint placement when route and foundation input ordering changes", () => {
    const first = [
      territory("a"),
      territory("b"),
      territory("c"),
      territory("d"),
    ];
    const second = structuredClone(first).reverse();
    const routes = [
      { from: "a", to: "b", weight: 5 },
      { from: "b", to: "c", weight: 3 },
      { from: "d", to: "a", weight: 8 },
    ];
    const fields = [foundation(["a", "c"]), foundation(["b", "d"], "other")];
    settlePackages(first, {}, 45, routes, fields);
    settlePackages(
      second,
      {},
      45,
      [...routes].reverse(),
      [...fields].reverse()
    );
    expect(positions(second)).toEqual(positions(first));
  });
  it("protects irregular coast extents beyond an island footprint", () => {
    const islands = [territory("a"), territory("b"), territory("c")];
    for (const island of islands) {
      island.coast = [
        [
          [
            [-180, -30],
            [180, -30],
            [180, 30],
            [-180, 30],
            [-180, -30],
          ],
        ],
      ];
    }
    settlePackages(islands, {}, 45, [], [foundation(["a", "b", "c"])]);
    const coastRadius = Math.hypot(180, 30) + 32;
    for (const [i, a] of islands.entries()) {
      for (const b of islands.slice(i + 1)) {
        expect(
          Math.hypot(a.x - b.x, a.y - b.y) - 2 * coastRadius
        ).toBeGreaterThanOrEqual(54.999);
      }
    }
  });
  it("clamps influence, keeps input immutable, and positions fields independently of visibility", async () => {
    const data = await loadSpyglass();
    data.foundations = [
      foundation(data.territories.slice(0, 3).map(({ id }) => id)),
    ];
    const saved = structuredClone(data);
    const on = relayoutSpyglass(data, 45, 1);
    expect(relayoutSpyglass(data, 45, 99)).toEqual(on);
    expect(relayoutSpyglass(data, 45, -1)).toEqual(
      relayoutSpyglass(data, 45, 0)
    );
    expect(relayoutSpyglass(data, 45, Number.NaN)).toEqual(
      relayoutSpyglass(data, 45, 0)
    );
    expect(lobesFollowIslands(on)).toBe(true);
    expect(positionFoundations(data.foundations, on.territories)).toEqual(
      on.foundations
    );
    expect(data).toEqual(saved);
  });
  it("qualifies memberships and keeps fields attached when collection frames move and relayout", async () => {
    const source = await loadSpyglass();
    source.foundations = positionFoundations(
      [foundation(source.territories.slice(0, 3).map(({ id }) => id))],
      source.territories
    );
    const first = qualifySpyglassData(source, { id: "first", label: "First" });
    const second = qualifySpyglassData(source, {
      id: "second",
      label: "Second",
    });
    const collection = composeCollection([first, second], []);
    expect(collection.foundations?.map(({ id }) => id)).toEqual([
      "first:dependency:shared",
      "second:dependency:shared",
    ]);
    expect(lobesFollowIslands(collection)).toBe(true);
    const relaid = relayoutSpyglass(collection, 80, 0.7);
    expect(lobesFollowIslands(relaid)).toBe(true);
    expect(
      relaid.foundations?.[0]?.members.every((member) =>
        member.territoryId.startsWith("first:")
      )
    ).toBe(true);
    expect(
      relaid.foundations?.[1]?.members.every((member) =>
        member.territoryId.startsWith("second:")
      )
    ).toBe(true);
    const firstDistances = first.territories.slice(0, 2).map(({ id }) => id);
    expect(
      firstDistances.every((id) =>
        relaid.territories.some((island) => island.id === id)
      )
    ).toBe(true);
  });
});
