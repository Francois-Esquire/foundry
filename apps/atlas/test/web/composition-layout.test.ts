import { describe, expect, it } from "vitest";

import {
  layoutComposition,
  layoutScenarioComposition,
} from "../../src/web/composition-layout";

describe("composition layout", () => {
  const groups = [
    {
      id: "shared",
      symbols: Array.from({ length: 318 }, (_, i) => ({
        symbolId: `shared-${i}`,
      })),
    },
    { id: "unknown", symbols: [{ symbolId: "unknown" }] },
    { id: "local", symbols: [{ symbolId: "private" }, { symbolId: "local" }] },
  ];
  it("is deterministic, non-mutating, and retains every declaration", () => {
    const before = structuredClone(groups);
    const layout = layoutComposition(groups);
    expect(layout).toHaveLength(321);
    expect(new Set(layout.map((mark) => mark.id)).size).toBe(321);
    expect(
      layoutComposition(
        [...groups].reverse().map((group) => ({
          ...group,
          symbols: [...group.symbols].reverse(),
        }))
      )
    ).toEqual(layout);
    expect(groups).toEqual(before);
  });
  it("leaves clearance between every pair of declaration marks", () => {
    const layout = layoutComposition(groups);
    for (let i = 0; i < layout.length; i++) {
      for (let j = i + 1; j < layout.length; j++) {
        const a = layout[i],
          b = layout[j];
        if (!(a && b)) {
          throw new Error("Missing declaration mark");
        }
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1.7);
      }
    }
  });
  it("handles empty composition", () => {
    expect(layoutComposition([])).toEqual([]);
  });
  it("offers compact clusters with the same membership and deterministic clearance", () => {
    const clusters = layoutComposition(groups, "clusters");
    expect(clusters.map((mark) => mark.id)).toEqual(
      layoutComposition(groups).map((mark) => mark.id)
    );
    expect(clusters).not.toEqual(layoutComposition(groups));
    expect(layoutComposition([...groups].reverse(), "clusters")).toEqual(
      clusters
    );
    for (let i = 0; i < clusters.length; i++) {
      for (const other of clusters.slice(i + 1)) {
        const mark = clusters[i];
        if (!mark) {
          throw new Error("Missing cluster mark");
        }
        expect(Math.hypot(mark.x - other.x, mark.y - other.y)).toBeGreaterThan(
          1.7
        );
      }
    }
  });
  it("traces only established subjects and required companions without changing the baseline", () => {
    const marks = layoutComposition(groups);
    const before = structuredClone(marks);
    const proposed = layoutScenarioComposition(marks, {
      closure: {
        blockers: [{ reason: "reverse-dependency", symbolId: "unknown" }],
        optional: [],
        required: [{ relationships: ["annotation"], symbolId: "private" }],
        size: "unresolved",
        subject: ["local"],
      },
      proposed: {
        candidateModules: [],
        exactPath: "deferred",
        scope: "responsibility-local",
      },
      subject: {
        key: "local",
        kind: "symbol-group",
        symbolIds: ["local", "absent"],
      },
    });
    expect(proposed.map((mark) => mark.id).sort()).toEqual([
      "local",
      "private",
    ]);
    expect(marks).toEqual(before);
    expect(
      proposed.every(
        (mark) => mark.x > Math.max(...marks.map((item) => item.x))
      )
    ).toBe(true);
    expect(
      layoutScenarioComposition(marks, {
        proposed: {
          candidateModules: [],
          exactPath: "deferred",
          scope: "unchanged",
        },
        subject: { key: "local", kind: "module" },
      })
    ).toEqual([]);
  });
});
