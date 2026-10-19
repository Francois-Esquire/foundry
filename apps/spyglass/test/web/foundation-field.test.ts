import { describe, expect, it } from "vitest";
import type { SpyglassFoundation } from "../../src/web/data/types";
import {
  foundationField,
  foundationOverviewLimit,
  visibleFoundations,
} from "../../src/web/layout/foundation-field";

function foundation(id: string, x: number, weight = 1): SpyglassFoundation {
  return {
    id,
    lobes: [
      { radius: 50, territoryId: `${id}-a`, weight, x: x - 20, y: 0 },
      { radius: 50, territoryId: `${id}-b`, weight, x: x + 20, y: 0 },
    ],
    members: [
      { direct: true, distance: 1, territoryId: `${id}-a`, weight },
      { direct: true, distance: 1, territoryId: `${id}-b`, weight },
    ],
    name: id,
    prominence: 2,
    versions: [],
    x,
    y: 0,
  };
}

describe("underwater foundation fields", () => {
  it("bounds overview density and allows any shared dependency to be inspected explicitly", () => {
    const fields = Array.from({ length: 30 }, (_, index) =>
      foundation(`field-${String(index).padStart(2, "0")}`, 0, index + 1)
    );
    const chosen = visibleFoundations(fields);
    expect(chosen).toHaveLength(foundationOverviewLimit);
    expect(chosen[0]?.id).toBe("field-29");
    expect(visibleFoundations(fields, "field-00").map(({ id }) => id)).toEqual([
      "field-00",
    ]);
    expect(visibleFoundations(fields, "missing")).toEqual([]);
    expect(visibleFoundations([...fields].reverse())).toEqual(chosen);
  });
  it("derives a deterministic bounded world-space surface without mutating settled geography", () => {
    const fields = [foundation("left", -120), foundation("right", 120, 1.25)];
    const saved = structuredClone(fields);
    const extent = { height: 300, width: 600 };
    const first = foundationField(fields, extent, "", 128);
    expect(foundationField(fields, extent, "", 128)).toEqual(first);
    expect(fields).toEqual(saved);
    expect(first.width).toBe(128);
    expect(first.height).toBe(64);
    expect(
      [...first.values].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1
      )
    ).toBe(true);
    expect(Math.max(...first.values)).toBeGreaterThan(0.5);
    expect(first.values[0]).toBe(0);
    const selected = foundationField(fields, extent, "left", 128);
    expect(selected.values).toEqual(
      foundationField(
        fields.filter(({ id }) => id === "left"),
        extent,
        "left",
        128
      ).values
    );
    expect(fields).toEqual(saved);
  });
  it("leaves empty or unavailable selections empty and limits the long dimension", () => {
    for (const extent of [
      { height: 300, width: 600 },
      { height: 700, width: 200 },
    ]) {
      const empty = foundationField([], extent, "", 96);
      expect(Math.max(empty.width, empty.height)).toBe(96);
      expect([...empty.values].every((value) => value === 0)).toBe(true);
      const missing = foundationField(
        [foundation("a", 0)],
        extent,
        "missing",
        96
      );
      expect(missing.values).toEqual(empty.values);
    }
  });
});
