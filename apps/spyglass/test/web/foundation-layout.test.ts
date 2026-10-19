import { describe, expect, it } from "vitest";
import { createFoundationAttraction } from "../../src/lib/visualization/affinity";
import { positionFoundations } from "../../src/lib/visualization/foundations";
import { settlePackages } from "../../src/lib/visualization/geography";
import {
  foundationGroupId,
  prepareFoundationGroups,
} from "../../src/lib/visualization/groups";
import {
  qualifySpyglassData,
  type SpyglassData,
  type SpyglassFoundation,
  type Territory,
} from "../../src/web/data/types";
import { composeCollection } from "../../src/web/layout/collection";
import { relayoutSpyglass } from "../../src/web/layout/geography";
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
  it("increases actual attraction above standard strength while keeping zero inert", () => {
    const displacement = (strength: number) => {
      const a = territory("a");
      const b = { ...territory("b"), x: 400 };
      createFoundationAttraction(
        [foundation(["a", "b"])],
        [a, b],
        strength
      ).apply();
      return a.x;
    };
    expect(displacement(0)).toBe(0);
    expect(displacement(3)).toBeGreaterThan(displacement(1) * 2);
    expect(displacement(99)).toBe(displacement(4));
  });
  it("pulls a pair more strongly as shared dependencies accumulate", () => {
    const move = (count: number, weight = 1) => {
      const first = territory("a");
      const second = territory("b");
      const islands = [first, second];
      second.x = 240;
      const fields = Array.from({ length: count }, (_, index) => {
        const field = foundation(["a", "b"], String(index));
        for (const member of field.members) {
          member.weight = weight;
        }
        return field;
      });
      createFoundationAttraction(fields, islands, 1).apply();
      return first.x;
    };
    expect(move(8)).toBeGreaterThan(move(1) * 2);
    expect(move(8, 0.2)).toBeLessThan(move(8));
    expect(move(0)).toBe(0);
  });

  it("leaves non-overlapping pairs alone and bounds repeated attraction relative to baseline", () => {
    const run = (count: number) => {
      const a = territory("a");
      const b = { ...territory("b"), x: 400 };
      const unrelated = { ...territory("unrelated"), x: 1000, y: 1000 };
      const field = createFoundationAttraction(
        Array.from({ length: count }, (_, i) =>
          foundation(["a", "b"], String(i))
        ),
        [a, b, unrelated],
        1
      );
      for (let i = 0; i < 1000; i += 1) {
        field.apply();
      }
      expect(unrelated.x).toBe(1000);
      expect(unrelated.y).toBe(1000);
      return b.x - a.x;
    };
    expect(run(0)).toBe(400);
    expect(run(1)).toBeGreaterThan(350);
    expect(run(8)).toBeLessThan(run(1));
    expect(run(100)).toBeGreaterThanOrEqual(200);
  });

  it("settles a strongly sharing pair closer than a weakly sharing pair", () => {
    const distance = (count: number) => {
      const islands = [territory("a"), territory("b"), territory("c")];
      const fields = [
        foundation(["b", "c"], "other"),
        ...Array.from({ length: count }, (_, index) =>
          foundation(["a", "b"], String(index))
        ),
      ];
      settlePackages(islands, { a: 0, b: 2, c: 0 }, 45, [], fields);
      const [a, b] = islands;
      if (!(a && b)) {
        throw new Error("Missing islands");
      }
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    expect(distance(8)).toBeLessThan(distance(1));
  });

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
          Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius
        ).toBeGreaterThanOrEqual(7.999);
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
  it("protects elongated land components during baseline refinement", () => {
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
    for (const [i, a] of islands.entries()) {
      for (const b of islands.slice(i + 1)) {
        expect(
          Math.max(Math.abs(a.x - b.x) - 360, Math.abs(a.y - b.y) - 60)
        ).toBeGreaterThanOrEqual(7.999);
      }
    }
  });
  it("contracts the baseline spacing progressively without collapsing to coast clearance", () => {
    const distance = (strength: number) => {
      const islands = [territory("a"), territory("b")];
      settlePackages(islands, {}, 45, [], [foundation(["a", "b"])], strength);
      const [a, b] = islands;
      if (!(a && b)) {
        throw new Error("Missing islands");
      }
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    expect(distance(3)).toBeLessThan(distance(1) - 8);
    expect(distance(3)).toBeGreaterThanOrEqual(88);
    expect(distance(1)).toBeLessThan(distance(0));
    expect(distance(1)).toBeGreaterThan(distance(0) * 0.8);
    expect(distance(3)).toBeGreaterThan(distance(0) * 0.5);
  });
  it("clamps influence, keeps input immutable, and positions fields independently of visibility", async () => {
    const data = await loadSpyglass();
    data.foundations = [
      foundation(data.territories.slice(0, 3).map(({ id }) => id)),
    ];
    const saved = structuredClone(data);
    const on = relayoutSpyglass(data, 45, 1);
    expect(relayoutSpyglass(data, 45, 99)).toEqual(
      relayoutSpyglass(data, 45, 4)
    );
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
    expect(on.foundationGroups).toEqual(
      prepareFoundationGroups(on.foundations ?? [], on.territories)
    );
    expect(on.foundationGroups?.[0]?.footprint.length).toBeGreaterThan(0);
    expect(data).toEqual(saved);
  });
  it("qualifies memberships and keeps fields attached when collection frames move and relayout", async () => {
    const source = await loadSpyglass();
    source.foundations = positionFoundations(
      [foundation(source.territories.slice(0, 3).map(({ id }) => id))],
      source.territories
    );
    source.foundationGroups = prepareFoundationGroups(source.foundations);
    const before = structuredClone(source);
    const first = qualifySpyglassData(source, { id: "first", label: "First" });
    const second = qualifySpyglassData(source, {
      id: "second",
      label: "Second",
    });
    expect(source).toEqual(before);
    const [qualifiedGroup] = first.foundationGroups ?? [];
    expect(qualifiedGroup?.memberIds).toEqual(
      source.foundationGroups[0]?.memberIds.map((id) => `first:${id}`)
    );
    expect(qualifiedGroup?.dependencyIds).toEqual(["first:dependency:shared"]);
    expect(qualifiedGroup?.footprint).toEqual(
      source.foundationGroups[0]?.footprint
    );
    expect(qualifiedGroup?.id).toBe(
      foundationGroupId(qualifiedGroup?.memberIds ?? [])
    );
    const collection = composeCollection([first, second], []);
    const [sourceIsland] = first.territories;
    const movedIsland = collection.territories.find(
      ({ id }) => id === sourceIsland?.id
    );
    if (!(sourceIsland && movedIsland && qualifiedGroup)) {
      throw new Error("Missing translated foundation fixture");
    }
    const dx = movedIsland.x - sourceIsland.x;
    const dy = movedIsland.y - sourceIsland.y;
    const translatedGroup = collection.foundationGroups?.find(
      ({ id }) => id === qualifiedGroup.id
    );
    expect(translatedGroup?.footprint).toEqual(
      qualifiedGroup.footprint.map((polygon) =>
        polygon.map((ring) => ring.map(([x, y]) => [x + dx, y + dy]))
      )
    );
    expect(translatedGroup?.footprint).not.toBe(qualifiedGroup.footprint);
    expect(translatedGroup?.slices).toEqual(
      qualifiedGroup.slices?.map((slice) =>
        slice.map((polygon) =>
          polygon.map((ring) => ring.map(([x, y]) => [x + dx, y + dy]))
        )
      )
    );
    expect(translatedGroup?.memberIds).toEqual(qualifiedGroup.memberIds);
    expect(collection.foundations?.map(({ id }) => id)).toEqual([
      "first:dependency:shared",
      "second:dependency:shared",
    ]);
    expect(lobesFollowIslands(collection)).toBe(true);
    const relaid = relayoutSpyglass(collection, 80, 0.7);
    expect(relaid.foundationGroups?.map(({ id }) => id).sort()).toEqual(
      collection.foundationGroups?.map(({ id }) => id).sort()
    );
    expect(relaid.foundationGroups).toEqual(
      prepareFoundationGroups(relaid.foundations ?? [], relaid.territories)
    );
    expect(relaid.foundationGroups?.[0]?.footprint).not.toEqual(
      collection.foundationGroups?.[0]?.footprint
    );
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

it("keeps group identities canonical across membership order and repeated IDs", () => {
  expect(foundationGroupId(["a", "b", "a"])).toBe(
    foundationGroupId(["b", "a"])
  );
  expect(foundationGroupId(["first:a", "first:b"])).not.toBe(
    foundationGroupId(["second:a", "second:b"])
  );
});
