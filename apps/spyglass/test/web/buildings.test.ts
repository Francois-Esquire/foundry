import { describe, expect, it } from "vitest";
import type { SpyglassFile, Territory } from "../../src/web/data/types";
import {
  buildingHeight,
  buildingVisible,
  layoutBuildings,
} from "../../src/web/layout/buildings";
import { insidePolygons } from "../../src/web/layout/polygons";
import { drapedHeight } from "../../src/web/layout/terrain-height";
import { loadSpyglass } from "../helpers/reference-spyglass";

const file = (id: string, x: number, y = 0, incoming = 0): SpyglassFile => ({
  directory: "src",
  highFanIn: false,
  id,
  incoming,
  internalFanIn: 0,
  kind: "source",
  outgoing: 0,
  path: `${id}.ts`,
  x,
  y,
});
const island = (files: SpyglassFile[]): Territory => ({
  analyzed: true,
  coast: [
    [
      [
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
        [-50, -50],
      ],
    ],
  ],
  fileRoles: undefined,
  files,
  folder: "",
  highFanInCutoff: 0,
  hills: [],
  id: "island",
  label: "Island",
  radius: 50,
  responsibilityGroups: undefined,
  shallows: [],
  x: 100,
  y: 200,
});

describe("file buildings", () => {
  it("retains geography and derives heights and landmarks from recorded import evidence", () => {
    const plain = file("plain", -10);
    const used = file("used", 10, 0, 15);
    const territory = island([plain, used]);
    const data = {
      routes: [
        {
          consumerFiles: [],
          from: "other",
          sharedConcepts: 0,
          supplierFiles: [used.id],
          to: territory.id,
          weight: 2,
        },
      ],
      territories: [territory],
    };
    const before = JSON.stringify(data);
    const buildings = layoutBuildings(data);
    expect(
      buildings.map((building) => [
        building.file.id,
        building.x,
        building.y,
        building.landmark,
      ])
    ).toEqual([
      ["plain", 90, 200, false],
      ["used", 110, 200, true],
    ]);
    expect(buildings.map((building) => building.height)).toEqual([3, 11]);
    expect(JSON.stringify(data)).toBe(before);
    expect(layoutBuildings(data)).toEqual(buildings);
    expect(buildingHeight(1000)).toBe(15);
    expect(buildingHeight(-2)).toBe(3);
  });

  it("shrinks footprints near shores and neighbors, and omits coincident files and holes", () => {
    const territory = island([
      file("shore", 49),
      file("a", 10),
      file("b", 12),
      file("coincident-a", -15),
      file("coincident-b", -15),
      file("hole", 0),
    ]);
    territory.coast[0]?.push([
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2],
      [-2, -2],
    ]);
    const buildings = layoutBuildings({ routes: [], territories: [territory] });
    expect(buildings.map((building) => building.file.id)).toEqual([
      "shore",
      "a",
      "b",
    ]);
    for (const building of buildings) {
      const radius = (building.width * 1.1) / 2;
      for (const dx of [-radius, radius]) {
        for (const dy of [-radius, radius]) {
          expect(
            insidePolygons(
              { x: building.file.x + dx, y: building.file.y + dy },
              territory.coast
            )
          ).toBe(true);
        }
      }
    }
    expect(buildings[0]?.width).toBeCloseTo(1.2);
    expect(buildings[1]?.width).toBeCloseTo(1.2);
  });

  it("uses the original relief for relaid files and suppresses only subpixel footprints", () => {
    const summit = {
      ...file("summit", 0, 0, 20),
      highFanIn: true,
      internalFanIn: 20,
    };
    const original = island([summit]);
    original.highFanInCutoff = 5;
    const relaid = { ...original, files: [file("summit", 10, 0, 20)] };
    const [building] = layoutBuildings(
      { routes: [], territories: [relaid] },
      () => original
    );
    expect(building).toBeDefined();
    if (!building) {
      return;
    }
    expect(building.base + building.footing).toBeGreaterThanOrEqual(
      drapedHeight(original, building.x, building.y)
    );
    expect(buildingVisible(building, 0.2)).toBe(false);
    expect(buildingVisible(building, 1)).toBe(true);
  });

  it("preserves real file identities with coast-contained, nonoverlapping roof footprints", async () => {
    const data = await loadSpyglass();
    const buildings = layoutBuildings(data);
    expect(buildings.length).toBeGreaterThan(100);
    for (const building of buildings) {
      expect(building.territory.files).toContain(building.file);
      expect(building.x).toBe(building.territory.x + building.file.x);
      const radius = (building.width * 1.1) / 2;
      for (const dx of [-radius, radius]) {
        for (const dy of [-radius, radius]) {
          expect(
            insidePolygons(
              { x: building.file.x + dx, y: building.file.y + dy },
              building.territory.coast
            )
          ).toBe(true);
        }
      }
    }
  });
});
