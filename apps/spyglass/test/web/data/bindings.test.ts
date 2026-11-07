import { describe, expect, it } from "vitest";
import {
  footprint,
  labelPriority,
  latitude,
  territoryLabelSize,
} from "../../../src/web/data/bindings";

describe("package bindings", () => {
  it("grows the footprint with the square root of size", () => {
    expect(footprint(0)).toBe(28);
    expect(footprint(100)).toBeCloseTo(86);
    expect(footprint(400)).toBeCloseTo(144);
  });

  it("places higher layers further north, the foundation at 0", () => {
    expect(latitude(0)).toBe(-0);
    expect(latitude(1)).toBe(-220);
    expect(latitude(7)).toBe(-1540);
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
