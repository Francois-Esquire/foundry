import { describe, expect, it } from "vitest";
import { dependencyCurrent } from "../../src/web/scene/current-field";
import type { AtlasData, Territory } from "../../src/web/types";
import { loadAtlas } from "../helpers/reference-atlas";

/** Three islands and the given package pairs, each `[from, to, module edges]`. */
function fixture(pairs: [string, string, number][]): AtlasData {
  const territory = (id: string, x: number, y: number): Territory => ({
    analyzed: true,
    coast: [],
    color: "#efcf88",
    fileRoles: undefined,
    files: [
      {
        directory: "",
        highFanIn: false,
        id,
        incoming: 0,
        internalFanIn: 0,
        kind: "source",
        outgoing: 0,
        path: id,
        x: 0,
        y: 0,
      },
    ],
    highFanInCutoff: 0,
    hills: [],
    id,
    label: id,
    radius: 30,
    responsibilityGroups: undefined,
    shallows: [],
    x,
    y,
  });
  return {
    coverage: "test",
    fileEdges: [],
    generatedAt: "test",
    height: 1000,
    routes: pairs.map(([from, to, weight]) => ({
      consumerFiles: [from],
      from,
      sharedConcepts: 0,
      supplierFiles: [to],
      to,
      weight,
    })),
    territories: [
      territory("a", -200, 0),
      territory("b", 200, 0),
      territory("c", -200, 400),
    ],
    width: 1000,
  };
}

describe("dependency current", () => {
  it("the captured routes' weights equal each pair's cross-package file edges", async () => {
    const data = await loadAtlas();
    const owner = new Map(
      data.territories.flatMap((p) => p.files.map((f) => [f.id, p.id]))
    );
    const counted = new Map<string, number>();
    for (const edge of data.fileEdges) {
      const from = owner.get(edge.source);
      const to = owner.get(edge.target);
      if (from && to && from !== to) {
        const key = `${from}→${to}`;
        counted.set(key, (counted.get(key) ?? 0) + 1);
      }
    }
    expect(counted.size).toBeGreaterThan(0);
    expect(
      new Map(data.routes.map((r) => [`${r.from}→${r.to}`, r.weight]))
    ).toEqual(counted);
  });

  it("follows importer to imported package and reverses with the edges", () => {
    const forward = dependencyCurrent(fixture([["a", "b", 1]]));
    const reverse = dependencyCurrent(fixture([["b", "a", 1]]));
    expect(forward.prevailing).toEqual({ x: 1, y: 0 });
    expect(reverse.prevailing).toEqual({ x: -1, y: 0 });
    expect(forward.sample(0, 0).x).toBeGreaterThan(0);
    expect(reverse.sample(0, 0).x).toBeLessThan(0);
  });
  it("strengthens connected corridors and retains a prevailing open-sea flow", () => {
    const weak = dependencyCurrent(fixture([["a", "b", 1]]));
    const strong = dependencyCurrent(fixture([["a", "b", 100]]));
    expect(strong.sample(0, 0).strength).toBeGreaterThan(
      weak.sample(0, 0).strength
    );
    expect(strong.sample(0, 0).strength).toBeGreaterThan(
      strong.sample(0, 900).strength
    );
    expect(strong.sample(0, 900).x).toBeGreaterThan(0);
  });
  it("blends competing directions smoothly without region borders", () => {
    const current = dependencyCurrent(
      fixture([
        ["a", "b", 1],
        ["a", "c", 1],
      ])
    );
    expect(current.sample(-200, 250).y).toBeGreaterThan(
      current.sample(150, 0).y
    );
    const a = current.sample(0, 100),
      b = current.sample(0.01, 100);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.001);
  });
  it("is deterministic under reordering and has no invented flow without a cross-package pair on the map", () => {
    const data = fixture([
      ["a", "b", 1],
      ["b", "a", 1],
    ]);
    const original = structuredClone(data);
    const first = dependencyCurrent(data).sample(0, 0);
    expect(data).toEqual(original);
    expect(
      dependencyCurrent({
        ...data,
        routes: [...data.routes].reverse(),
        territories: [...data.territories].reverse(),
      }).sample(0, 0)
    ).toEqual(first);
    expect(
      dependencyCurrent(
        fixture([
          ["a", "a", 3],
          ["missing", "b", 2],
          ["a", "c", 0],
        ])
      ).sample(0, 0)
    ).toEqual({ strength: 0, x: 0, y: 0 });
  });
});
