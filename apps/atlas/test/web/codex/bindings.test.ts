import { describe, expect, it } from "vitest";
import {
  attraction,
  currentStrength,
  districtAffinity,
  footprint,
  labelPriority,
  laneWidth,
  latitude,
  neighborhoodAffinity,
  roadWidth,
  settlementTier,
  territoryLabelSize,
} from "../../../src/web/codex/bindings";

describe("package bindings", () => {
  it("grows the footprint with the square root of size", () => {
    expect(footprint(0)).toBe(28);
    expect(footprint(100)).toBeCloseTo(86);
    expect(footprint(400)).toBeCloseTo(144);
  });

  it("places deeper layers further south", () => {
    expect(latitude(0)).toBe(-0);
    expect(latitude(1)).toBe(-220);
    expect(latitude(7)).toBe(-1540);
  });

  it("strengthens attraction logarithmically", () => {
    expect(attraction(0)).toBe(1);
    expect(attraction(2)).toBe(2);
    expect(attraction(6)).toBe(3);
  });

  it("tiers settlements at 40 and 300 modules", () => {
    expect([0, 39, 40, 299, 300, 1000].map(settlementTier)).toEqual([
      "village",
      "village",
      "town",
      "town",
      "city",
      "city",
    ]);
  });

  it("bounds territory labels between 13 and 22", () => {
    expect(territoryLabelSize(40)).toBe(13);
    expect(territoryLabelSize(100)).toBeCloseTo(15);
    expect(territoryLabelSize(200)).toBe(22);
  });
});

describe("module bindings", () => {
  it("ranks labels by imports in both directions", () => {
    expect(labelPriority(0, 0)).toBe(0);
    expect(labelPriority(3, 4)).toBe(7);
  });

  it("adds at most half an import for shared concepts", () => {
    expect(neighborhoodAffinity(2, 0)).toBe(2);
    expect(neighborhoodAffinity(2, 0.4)).toBeCloseTo(2.2);
    expect(neighborhoodAffinity(2, 5)).toBe(2.5);
  });
});

describe("relationship bindings", () => {
  it("scales lane and road width against the strongest route", () => {
    expect(laneWidth(0, 10)).toBe(0.35);
    expect(laneWidth(10, 10)).toBeCloseTo(0.6);
    expect(laneWidth(3, 10)).toBeGreaterThan(laneWidth(2, 10));
    expect(roadWidth(0, 10)).toBe(0.7);
    expect(roadWidth(10, 10)).toBeCloseTo(1.7);
    expect(roadWidth(3, 10)).toBeGreaterThan(roadWidth(2, 10));
  });

  it("dampens import counts for currents and districts", () => {
    expect(currentStrength(0)).toBe(0);
    expect(currentStrength(Math.E - 1)).toBeCloseTo(1);
    expect(districtAffinity(0, 0)).toBe(0);
    expect(districtAffinity(Math.E - 1, Math.E - 1)).toBeCloseTo(2);
  });
});
