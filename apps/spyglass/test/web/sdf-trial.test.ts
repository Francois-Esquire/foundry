import { describe, expect, it } from "vitest";
import {
  islandSpacing,
  trialPlan,
  trialSpacings,
} from "../../src/web/layout/sdf-trial";
import { loadSpyglass } from "../helpers/reference-spyglass";

describe("the SDF trial's plan", () => {
  it("plans every island of the chart, its region holding its coast and its range the water", async () => {
    const plan = trialPlan(await loadSpyglass());
    const { world } = plan.chart;
    expect(plan.islands).toHaveLength(world.islands.length);
    for (const island of plan.islands) {
      const source = world.islands.find((each) => each.id === island.id);
      for (const polygon of source?.coast ?? []) {
        for (const ring of polygon) {
          for (const [x = 0, y = 0] of ring) {
            expect(source && source.x + x).toBeGreaterThan(island.left);
            expect(source && source.x + x).toBeLessThan(
              island.left + island.width
            );
            expect(source && source.y + y).toBeGreaterThan(island.top);
            expect(source && source.y + y).toBeLessThan(
              island.top + island.height
            );
          }
        }
      }
      // Regions snap to whole map units, so every spacing's lattice aligns.
      expect(Number.isInteger(island.left)).toBe(true);
      expect(Number.isInteger(island.width)).toBe(true);
      expect(island.zLow).toBeLessThan(0);
      expect(island.zHigh).toBeGreaterThan(0);
      expect(world.islandIds[island.index]).toBe(island.id);
    }
  });
});

describe("an island's spacing", () => {
  const island = { height: 40, left: 0, top: 0, width: 40 };
  const view = { height: 100, width: 100, x: 20, y: 20 };

  it("is the close spacing for an island in view up close, the overview's otherwise", () => {
    expect(
      islandSpacing(island, { ...view, pixelsPerUnit: 3 }, 2, undefined)
    ).toBe(trialSpacings.close);
    expect(
      islandSpacing(island, { ...view, pixelsPerUnit: 1 }, 2, undefined)
    ).toBe(trialSpacings.overview);
    expect(
      islandSpacing(
        island,
        { ...view, pixelsPerUnit: 3, x: 500 },
        2,
        trialSpacings.close
      )
    ).toBe(trialSpacings.overview);
  });

  it("keeps what it has between the thresholds, so a resting view never rebuilds back and forth", () => {
    const between = { ...view, pixelsPerUnit: 1.75 };
    expect(islandSpacing(island, between, 2, trialSpacings.close)).toBe(
      trialSpacings.close
    );
    expect(islandSpacing(island, between, 2, trialSpacings.overview)).toBe(
      trialSpacings.overview
    );
  });
});
