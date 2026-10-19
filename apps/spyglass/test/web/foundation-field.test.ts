import { describe, expect, it } from "vitest";
import type { FoundationGroup } from "../../src/lib/visualization/types";
import {
  createFoundationFields,
  foundationField,
} from "../../src/web/layout/foundation-field";

function group(id: string, left = -30, right = 30): FoundationGroup {
  return {
    dependencyIds: [`dependency:${id}`],
    footprint: [
      [
        [
          [left, -30],
          [right, -30],
          [right, 30],
          [left, 30],
          [left, -30],
        ],
      ],
    ],
    id,
    memberIds: [`${id}-a`, `${id}-b`],
  };
}
const extent = { height: 200, width: 200 };
const at = (
  field: ReturnType<typeof foundationField>,
  x: number,
  y: number,
  channel = 0
) => field.values[(y * field.width + x) * 2 + channel];

describe("independent underwater group layers", () => {
  it("normalizes a group's contour slices before combining shared overlap", () => {
    const outer = group("shelf", -60, 60);
    const inner = group("inner", -10, 10);
    const layered = { ...outer, slices: [outer.footprint, inner.footprint] };
    const field = foundationField([layered], extent, "", 100);
    expect(at(field, 25, 50)).toBe(0.5);
    expect(at(field, 50, 50)).toBe(1);
    expect(at(field, 0, 0)).toBe(0);
    const overlap = foundationField(
      [layered, { ...layered, id: "second" }],
      extent,
      "",
      100
    );
    expect(at(overlap, 50, 50)).toBe(2);
  });
  it("preserves every group above twelve and counts actual overlap", () => {
    const groups = Array.from({ length: 30 }, (_, index) =>
      group(`group-${index}`)
    );
    const field = foundationField(groups, extent, "", 100);
    expect(at(field, 50, 50)).toBe(30);
    expect(at(field, 50, 50, 1)).toBe(0);
    expect(at(field, 35, 50, 1)).toBe(30);
    expect(at(field, 0, 0)).toBe(0);
  });
  it("isolates a group or any dependency it represents using the same cached masks", () => {
    const groups = [group("left", -60, 10), group("right", -10, 60)];
    const original = structuredClone(groups);
    const fields = createFoundationFields(groups, extent, 100);
    expect(at(fields.compose(), 50, 50)).toBe(2);
    expect(at(fields.compose(), 25, 50)).toBe(1);
    expect(fields.compose("left")).toEqual(fields.compose("dependency:left"));
    expect(at(fields.compose("left"), 50, 50)).toBe(1);
    expect(at(fields.compose("left"), 75, 50)).toBe(0);
    expect(fields.compose("missing").values.every((value) => value === 0)).toBe(
      true
    );
    expect(fields.compose()).toEqual(
      foundationField([...groups].reverse(), extent, "", 100)
    );
    expect(groups).toEqual(original);
  });
  it("preserves polygon holes and disconnected pieces", () => {
    const island = group("hole", -60, 60);
    island.footprint[0]?.push([
      [-10, -10],
      [-10, 10],
      [10, 10],
      [10, -10],
      [-10, -10],
    ]);
    island.footprint.push([
      [
        [70, 70],
        [90, 70],
        [90, 90],
        [70, 90],
        [70, 70],
      ],
    ]);
    const field = foundationField([island], extent, "", 100);
    expect(at(field, 50, 50)).toBe(0);
    expect(at(field, 25, 50)).toBe(1);
    expect(at(field, 90, 90)).toBe(1);
  });
  it("handles empty and off-chart footprints without allocation overflow", () => {
    const empty = { ...group("empty"), footprint: [] };
    const outside = group("outside", 500, 600);
    expect(
      foundationField([empty, outside], extent, "", 100).values.every(
        (value) => value === 0
      )
    ).toBe(true);
    expect(
      foundationField([], { height: 700, width: 200 }, "", 96).height
    ).toBe(96);
  });
  it("returns a finite empty field for degenerate or nonfinite extents", () => {
    for (const bounds of [
      { height: 200, width: 0 },
      { height: 0, width: 200 },
      { height: 20, width: -1 },
      { height: 20, width: Number.NaN },
      { height: Number.POSITIVE_INFINITY, width: 20 },
    ]) {
      const field = foundationField([group("a")], bounds, "", 100);
      expect([field.width, field.height]).toEqual([2, 2]);
      expect([...field.values]).toEqual(new Array(8).fill(0));
    }
  });
  it("clips coverage without inventing a contour at the texture boundary", () => {
    const enclosing = group("enclosing", -500, 500);
    enclosing.footprint = [
      [
        [
          [-500, -500],
          [500, -500],
          [500, 500],
          [-500, 500],
          [-500, -500],
        ],
      ],
    ];
    const field = foundationField([enclosing], extent, "", 100);
    expect(at(field, 0, 0)).toBe(1);
    expect(at(field, 99, 99)).toBe(1);
    expect(at(field, 0, 0, 1)).toBe(0);
    expect(at(field, 99, 99, 1)).toBe(0);
    const partial = foundationField(
      [group("partial", -500, 30)],
      extent,
      "",
      100
    );
    expect(at(partial, 0, 50)).toBe(1);
    expect(at(partial, 0, 50, 1)).toBe(0);
    expect(at(partial, 64, 50, 1)).toBe(1);
  });
  it("keeps very narrow extents bounded and resolves a one-cell-wide footprint", () => {
    const thin = foundationField([group("thin", 0, 2)], extent, "", 100);
    expect(at(thin, 50, 50)).toBe(1);
    expect(at(thin, 49, 50)).toBe(0);
    expect(at(thin, 51, 50)).toBe(0);
    const narrow = foundationField(
      [group("narrow")],
      { height: 1000, width: 0.000_01 },
      "",
      100
    );
    expect([narrow.width, narrow.height]).toEqual([2, 100]);
    expect([...narrow.values].every(Number.isFinite)).toBe(true);
  });
});
