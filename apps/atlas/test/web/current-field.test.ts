import { describe, expect, it } from "vitest";
import { dependencyCurrent } from "../../src/web/scene/current-field";
import type { AtlasData, Territory } from "../../src/web/types";

function fixture(edges: { source: string; target: string }[]): AtlasData {
  const territory = (id: string, x: number, y: number): Territory => ({
    analyzed: true,
    coast: [],
    color: "#efcf88",
    files: [
      {
        directory: "",
        id,
        incoming: 0,
        kind: "source",
        outgoing: 0,
        path: id,
        x: 0,
        y: 0,
      },
    ],
    hills: [],
    id,
    label: id,
    neighborhoods: [],
    radius: 30,
    shallows: [],
    x,
    y,
  });
  return {
    coverage: "test",
    fileEdges: edges,
    generatedAt: "test",
    height: 1000,
    routes: [],
    territories: [
      territory("a", -200, 0),
      territory("b", 200, 0),
      territory("c", -200, 400),
    ],
    width: 1000,
  };
}

describe("dependency current", () => {
  it("follows importer to imported package and reverses with the edges", () => {
    const forward = dependencyCurrent(fixture([{ source: "a", target: "b" }]));
    const reverse = dependencyCurrent(fixture([{ source: "b", target: "a" }]));
    expect(forward.prevailing).toEqual({ x: 1, y: 0 });
    expect(reverse.prevailing).toEqual({ x: -1, y: 0 });
    expect(forward.sample(0, 0).x).toBeGreaterThan(0);
    expect(reverse.sample(0, 0).x).toBeLessThan(0);
  });
  it("strengthens connected corridors and retains a prevailing open-sea flow", () => {
    const weak = dependencyCurrent(fixture([{ source: "a", target: "b" }]));
    const strong = dependencyCurrent(
      fixture(Array.from({ length: 100 }, () => ({ source: "a", target: "b" })))
    );
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
        { source: "a", target: "b" },
        { source: "a", target: "c" },
      ])
    );
    expect(current.sample(-200, 250).y).toBeGreaterThan(
      current.sample(150, 0).y
    );
    const a = current.sample(0, 100),
      b = current.sample(0.01, 100);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.001);
  });
  it("is deterministic under reordering and has no invented flow without cross-package edges", () => {
    const data = fixture([
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ]);
    const original = structuredClone(data);
    const first = dependencyCurrent(data).sample(0, 0);
    expect(data).toEqual(original);
    expect(
      dependencyCurrent({
        ...data,
        fileEdges: [...data.fileEdges].reverse(),
        territories: [...data.territories].reverse(),
      }).sample(0, 0)
    ).toEqual(first);
    expect(
      dependencyCurrent(
        fixture([
          { source: "a", target: "a" },
          { source: "missing", target: "b" },
        ])
      ).sample(0, 0)
    ).toEqual({ strength: 0, x: 0, y: 0 });
  });
});
