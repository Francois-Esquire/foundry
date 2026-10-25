import { expect, it } from "vitest";
import type { Territory } from "../../src/web/data/types";
import type { BelongingLayer } from "../../src/web/layout/belonging";
import type { Landmark } from "../../src/web/layout/landmarks";
import type { NaturalFeature } from "../../src/web/layout/natural-feature-inspection";
import {
  drawnBelonging,
  resolveSetTerritoryLayout,
} from "../../src/web/scene/view-state";
import { loadSpyglass } from "../helpers/reference-spyglass";

const territory = { id: "island" } as Territory;
/** A landmark by its basis alone; the merge reads none of its substance. */
const landmark = (basis: Landmark["basis"]): NaturalFeature => ({
  kind: "landmark",
  landmark: { basis } as Partial<Landmark> as Landmark,
});
const applied: BelongingLayer = {
  featureFocus: landmark("commons"),
  regions: [],
  territory,
};

it("draws the applied layer as it is, with the reveal's progress while one runs", () => {
  expect(
    drawnBelonging({
      belonging: applied,
      belongingHover: null,
      belongingReveal: undefined,
    })
  ).toBe(applied);
  expect(
    drawnBelonging({
      belonging: applied,
      belongingHover: null,
      belongingReveal: 0.5,
    })
  ).toEqual({ ...applied, reveal: 0.5 });
  expect(
    drawnBelonging({
      belonging: null,
      belongingHover: { emphasis: 1 },
      belongingReveal: 0.5,
    })
  ).toBeNull();
});

it("lays the pointer's hover over the layer, keeping the applied focus when the pointer points at no feature", () => {
  const marsh = landmark("junction");
  expect(
    drawnBelonging({
      belonging: applied,
      belongingHover: { emphasis: 0.25, feature: marsh, hovered: "region" },
      belongingReveal: undefined,
    })
  ).toEqual({
    ...applied,
    emphasis: 0.25,
    featureFocus: marsh,
    hovered: "region",
  });
  expect(
    drawnBelonging({
      belonging: applied,
      belongingHover: { emphasis: 1 },
      belongingReveal: undefined,
    })
  ).toEqual({ ...applied, emphasis: 1, hovered: undefined });
});

it("puts a relaid island in place of its laid-out self and leaves the rest", async () => {
  const data = await loadSpyglass();
  const [first] = data.territories;
  if (!first) {
    throw new Error("Missing territory");
  }
  const moved = { ...first, x: first.x + 100 };
  const resolved = resolveSetTerritoryLayout(moved, data);
  expect(resolved.territories[0]).toBe(moved);
  expect(resolved.territories.slice(1)).toEqual(data.territories.slice(1));
  expect(resolveSetTerritoryLayout(null, data)).toBe(data);
});
