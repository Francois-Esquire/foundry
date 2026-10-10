import { describe, expect, it } from "vitest";
import {
  attraction,
  footprint,
  labelPriority,
  landmarkRadius,
  laneWidth,
  latitude,
  roadWidth,
  summitHeight,
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
});

describe("summit bindings", () => {
  it("raises a high fan-in summit from its fan-in over the package's saved cutoff", () => {
    expect(summitHeight(3, 3)).toBeCloseTo(1.8 * Math.log2(4 / 3));
    expect(summitHeight(11, 3)).toBeCloseTo(3.6);
    expect(summitHeight(1, 3)).toBe(0);
    expect(summitHeight(20, 0)).toBe(0);
  });

  it("gives a module at its cutoff a footprint of 2 + 0.8√5, growing with fan-in up to 6, and 2 without a cutoff", () => {
    expect(landmarkRadius(3, 3)).toBeCloseTo(2 + 0.8 * Math.sqrt(5));
    expect(landmarkRadius(0, 3)).toBe(2);
    expect(landmarkRadius(12, 0)).toBe(2);
    expect(landmarkRadius(300, 3)).toBe(6);
  });
});
