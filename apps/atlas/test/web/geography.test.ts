import { assert, describe, expect, it } from "vitest";
import {
  landContours,
  relayoutAtlas,
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
  it("leaves water between disconnected file clusters", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...file(String(i)),
      x: i < 20 ? -60 : 60,
      y: (i % 20) * 0.2,
    }));
    expect(landContours(many, 100)[1]?.length).toBe(2);
    expect(landContours([], 100)).toEqual([[], [], []]);
  });
  it("restores deterministic dependency-pulled placement instead of exact layer rows", () => {
    const islands = [region("web", 0), region("core", 0), region("tools", 0)];
    const layers = { core: 0, tools: 2, web: 2 };
    const routes = [
      { from: "web", to: "core", weight: 15 },
      { from: "tools", to: "core", weight: 3 },
    ];
    settlePackages(islands, layers, 45, routes);
    const again = [region("web", 0), region("core", 0), region("tools", 0)];
    settlePackages(again, layers, 45, routes);
    expect(again).toEqual(islands);
    const [web, , tools] = islands;
    assert(web && tools);
    expect(web.y).not.toBe(tools.y);
    for (const [i, a] of islands.entries()) {
      for (const b of islands.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(100);
      }
    }
  });
  it("relays out the geography in two dimensions without changing file composition", async () => {
    const original = await loadAtlas();
    const saved = structuredClone(original);
    const near = relayoutAtlas(original, 8);
    const far = relayoutAtlas(original, 80);
    expect(relayoutAtlas(original, 8)).toEqual(near);
    expect(far.territories.some((p, i) => p.y !== near.territories[i]?.y)).toBe(
      true
    );
    expect(far.territories.map((p) => p.files)).toEqual(
      original.territories.map((p) => p.files)
    );
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
