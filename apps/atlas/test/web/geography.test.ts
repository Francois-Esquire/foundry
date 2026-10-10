import { describe, expect, it } from "vitest";
import { latitude } from "../../src/web/codex/bindings";
import {
  landContours,
  relayoutAtlas,
  settleFiles,
  settlePackages,
} from "../../src/web/geography";
import type { AtlasFile, Territory } from "../../src/web/types";
import { loadAtlas } from "../helpers/reference-atlas";

const file = (id: string): AtlasFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming: 0,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path: id,
  x: 0,
  y: 0,
});
const region = (id: string, x: number): Territory => ({
  analyzed: true,
  coast: [],
  fileRoles: undefined,
  files: [],
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id,
  label: id,
  radius: 40,
  responsibilityGroups: undefined,
  shallows: [],
  x,
  y: 0,
});

describe("atlas geography", () => {
  it("reproduces file geometry for the same identifiers and imports", () => {
    const a = [file("a"), file("b"), file("c")];
    const b = structuredClone(a);
    const links = [{ source: "a", target: "b" }];
    settleFiles(a, 60, links);
    settleFiles(b, 60, links);
    expect(a).toEqual(b);
    expect(new Set(a.map((f) => `${f.x},${f.y}`)).size).toBe(3);
    expect(a.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y))).toBe(
      true
    );
  });
  it("leaves water between disconnected file clusters", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...file(String(i)),
      x: i < 20 ? -60 : 60,
      y: (i % 20) * 0.2,
    }));
    expect(landContours(many, 100)[1]?.length).toBe(2);
    expect(landContours([], 100)).toEqual([[], [], []]);
  });
  it("puts each island on its layer's latitude, a row west to east by package folder", () => {
    const islands = [
      { ...region("tools", 0), folder: "tooling/lint" },
      // By code unit a capital sorts before every lower case letter; by locale "Web" would come last.
      { ...region("web", 0), folder: "Web" },
      { ...region("core", 0), folder: "packages/core" },
      region("unplaced", 0),
    ];
    settlePackages(islands, { core: 2, tools: 2, unplaced: null, web: 2 }, 45);
    const at = (id: string) => islands.find((p) => p.id === id);
    // Rows keep their latitudes' spacing, the whole atlas centred.
    const offset = (at("web")?.y ?? 0) - latitude(2);
    expect(islands.map((p) => p.y - offset)).toEqual([
      latitude(2),
      latitude(2),
      latitude(2),
      0,
    ]);
    expect(at("web")?.x).toBeLessThan(at("core")?.x ?? 0);
    expect(at("core")?.x).toBeLessThan(at("tools")?.x ?? 0);
    // Padded coasts (radius 40 + 32 without a coast) keep 45 apart in a row.
    expect((at("tools")?.x ?? 0) - (at("core")?.x ?? 0)).toBeCloseTo(189, 6);
  });
  it("parts overlapping islands of neighbouring rows along x only", () => {
    const north = { ...region("north", 0), radius: 150 };
    const south = { ...region("south", 0), radius: 150 };
    const islands = [north, south];
    const layers = { north: 1, south: 0 };
    settlePackages(islands, layers, 45);
    expect(north.y - south.y).toBe(latitude(1));
    // Centred north of the origin, leaving sea below the foundation for the legend.
    expect(north.y + south.y).toBeLessThan(0);
    const span = 2 * (150 + 32) + 45;
    expect(Math.hypot(north.x - south.x, latitude(1))).toBeCloseTo(span, 1);
    expect(north.x + south.x).toBeCloseTo(0, 6);
    const again = [
      { ...region("north", 0), radius: 150 },
      { ...region("south", 0), radius: 150 },
    ].reverse();
    settlePackages(again, layers, 45);
    expect(again.reverse()).toEqual(islands);
  });
  it("keeps every pair of the reference atlas's islands the clearance apart, each on its row", async () => {
    const original = await loadAtlas();
    // The capture has no layers: give it four rows and an unplaced package.
    const packageLayers = Object.fromEntries(
      original.territories.map((p, i) => [p.id, i === 0 ? null : i % 4])
    );
    // A padded coast reaches 32 units past the farthest coast point.
    const reach = (p: Territory) =>
      Math.max(
        ...p.coast.flatMap((polygon) =>
          (polygon[0] ?? []).map(([x = 0, y = 0]) => Math.hypot(x, y))
        )
      ) + 32;
    for (const clearance of [8, 45, 80]) {
      const { territories } = relayoutAtlas(
        { ...original, packageLayers },
        clearance
      );
      const rows = new Map<number, number>();
      for (const p of territories) {
        const layer = packageLayers[p.id] ?? 0;
        rows.set(layer, rows.get(layer) ?? p.y);
        expect(p.y).toBe(rows.get(layer));
      }
      for (const [layer, y] of rows) {
        expect(y - (rows.get(0) ?? 0)).toBe(latitude(layer) - latitude(0));
      }
      for (const [i, a] of territories.entries()) {
        for (const b of territories.slice(i + 1)) {
          const gap = Math.hypot(a.x - b.x, a.y - b.y) - reach(a) - reach(b);
          expect(gap, `${a.id}, ${b.id}`).toBeGreaterThanOrEqual(
            clearance - 0.01
          );
        }
      }
    }
  });
  it("lays the atlas out again at another clearance, moving islands along x only", async () => {
    const original = await loadAtlas();
    const saved = structuredClone(original);
    const near = relayoutAtlas(original, 8);
    const far = relayoutAtlas(original, 80);
    expect(relayoutAtlas(original, 8)).toEqual(near);
    for (const [i, p] of far.territories.entries()) {
      const before = near.territories[i];
      expect({ ...p, x: 0 }).toEqual({ ...before, x: 0 });
    }
    expect(far.width).toBeGreaterThan(near.width);
    expect(original).toEqual(saved);
  });
  it("loads the real survey with finite geography and contours for populated regions", async () => {
    const data = await loadAtlas();
    expect(data.territories.length).toBeGreaterThan(0);
    expect(data.routes.length).toBeGreaterThan(0);
    expect(
      data.territories.every(
        (p) => Number.isFinite(p.x) && Number.isFinite(p.y)
      )
    ).toBe(true);
    expect(
      data.territories
        .filter((p) => p.files.length)
        .every((p) => p.coast.length > 0)
    ).toBe(true);
    expect(data.width).toBeGreaterThan(0);
    expect(data.height).toBeGreaterThan(0);
  });
});
