import { describe, expect, it } from "vitest";

import { deriveHierarchy } from "../../src/web/hierarchy";

const region = (id: string) => ({ id, label: id });
const edge = (from: string, to: string, moduleEdges = 20, symbolFlow = 20) => ({
  from,
  moduleEdges,
  symbolFlow,
  to,
});

describe("architectural composites", () => {
  it("separates strongly connected groups across a weak bridge", () => {
    const result = deriveHierarchy({
      regions: ["a", "b", "c", "d", "e", "f"].map(region),
      relationships: [
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "a"),
        edge("d", "e"),
        edge("e", "f"),
        edge("f", "d"),
        edge("c", "d", 1, 0),
      ],
    });
    expect(result.composites.map((group) => group.regions)).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
    expect(result.independent).toEqual([]);
    expect(result.composites.map((group) => group.anchor)).toEqual(["a", "d"]);
  });

  it("retains independent evidence without manufacturing communities", () => {
    expect(deriveHierarchy({ regions: [], relationships: [] })).toEqual({
      composites: [],
      independent: [],
    });
    const result = deriveHierarchy({
      regions: ["z", "b", "a", "alone"].map(region),
      relationships: [edge("a", "b"), edge("z", "z"), edge("a", "missing")],
    });
    expect(result.composites.map((group) => group.regions)).toEqual([
      ["a", "b"],
    ]);
    expect(result.independent).toEqual(["alone", "z"]);
  });

  it("uses connectivity within a composite for its anchor", () => {
    const result = deriveHierarchy({
      regions: ["a", "b", "c"].map(region),
      relationships: [edge("a", "b"), edge("b", "c")],
    });
    expect(result.composites[0]?.anchor).toBe("b");
    expect(result.composites[0]?.label).toBe("b");
    expect(result.composites[0]?.anchorWeight).toBeCloseTo(4 * Math.log1p(20));
  });

  it("is deterministic, preserves canonical coverage, and never mutates evidence", () => {
    const evidence = {
      regions: ["e", "c", "a", "d", "b", "alone"].map(region),
      relationships: [edge("a", "b"), edge("b", "c"), edge("d", "e")],
    };
    const before = structuredClone(evidence);
    const result = deriveHierarchy(evidence);
    expect(
      deriveHierarchy({
        regions: [...evidence.regions].reverse(),
        relationships: [...evidence.relationships].reverse(),
      })
    ).toEqual(result);
    expect(evidence).toEqual(before);
    const ids = [
      ...result.composites.flatMap((group) => group.regions),
      ...result.independent,
    ];
    expect(ids.sort()).toEqual(["a", "alone", "b", "c", "d", "e"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(result.composites.map((group) => group.id)).size).toBe(
      result.composites.length
    );
  });
});
