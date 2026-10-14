import { assert, describe, expect, it } from "vitest";
import {
  landContours,
  relayoutSpyglass,
  settlePackages,
} from "../../src/web/geography";
import type { SpyglassFile, Territory } from "../../src/web/types";
import { loadSpyglass } from "../helpers/reference-spyglass";

const file = (id: string): SpyglassFile => ({
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

describe("spyglass geography", () => {
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
  it("places unconnected islands around the archipelago while retaining the connected composition", () => {
    const main = [region("web", 0), region("core", 0)];
    const islands = [
      ...structuredClone(main),
      region("@foundry/docs", 0),
      region("@foundry/release", 0),
      region("@foundry/website", 0),
    ];
    const layers = { core: 0, docs: 0, release: 0, web: 2, website: 0 };
    const routes = [{ from: "web", to: "core", weight: 15 }];
    settlePackages(main, layers, 45, routes);
    settlePackages(islands, layers, 45, routes);
    const [web, core] = islands;
    const [aloneWeb, aloneCore] = main;
    assert(web && core && aloneWeb && aloneCore);
    // Only a common framing translation may change the connected islands.
    expect(web.x - core.x).toBeCloseTo(aloneWeb.x - aloneCore.x, 8);
    expect(web.y - core.y).toBeCloseTo(aloneWeb.y - aloneCore.y, 8);
    const offshore = islands.slice(2);
    expect(new Set(offshore.map((island) => Math.round(island.y))).size).toBe(
      3
    );
    const angles = offshore.map((island) =>
      Math.atan2(
        island.y - (web.y + core.y) / 2,
        island.x - (web.x + core.x) / 2
      )
    );
    for (const [i, angle] of angles.entries()) {
      for (const other of angles.slice(i + 1)) {
        expect(
          Math.abs(Math.atan2(Math.sin(angle - other), Math.cos(angle - other)))
        ).toBeGreaterThanOrEqual(Math.PI / 4 - 1e-8);
      }
    }
    for (const island of offshore) {
      for (const other of islands) {
        if (island !== other) {
          expect(
            Math.hypot(island.x - other.x, island.y - other.y)
          ).toBeGreaterThan(island.radius + other.radius + 45);
        }
      }
    }
    const again = structuredClone(islands);
    settlePackages(again, layers, 45, routes);
    expect(again).toEqual(islands);
  });
  it("keeps an entirely disconnected workspace finite and separated, ignoring self and missing links", () => {
    const islands = [region("one", 0), region("two", 0), region("three", 0)];
    settlePackages(islands, {}, 80, [
      { from: "one", to: "one", weight: 3 },
      { from: "two", to: "absent", weight: 3 },
    ]);
    for (const [i, island] of islands.entries()) {
      expect(Number.isFinite(island.x) && Number.isFinite(island.y)).toBe(true);
      for (const other of islands.slice(i + 1)) {
        expect(
          Math.hypot(island.x - other.x, island.y - other.y)
        ).toBeGreaterThan(island.radius + other.radius + 80);
      }
    }
    expect(() => settlePackages([], {}, 45)).not.toThrow();
  });
  it("relays out the geography in two dimensions without changing file composition", async () => {
    const original = await loadSpyglass();
    const saved = structuredClone(original);
    const near = relayoutSpyglass(original, 8);
    const far = relayoutSpyglass(original, 80);
    expect(relayoutSpyglass(original, 8)).toEqual(near);
    expect(far.territories.some((p, i) => p.y !== near.territories[i]?.y)).toBe(
      true
    );
    expect(far.territories.map((p) => p.files)).toEqual(
      original.territories.map((p) => p.files)
    );
    expect(original).toEqual(saved);
  });
  it("loads the real survey with finite geography and contours for populated regions", async () => {
    const data = await loadSpyglass();
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
