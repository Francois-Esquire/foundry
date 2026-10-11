import { BufferAttribute, BufferGeometry, Mesh } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { createTradeLayer } from "../../src/web/scene/trade-layer";
import { createTradeNavigation } from "../../src/web/trade-routes";
import type { AtlasData, Territory } from "../../src/web/types";

const island = (id: string, x: number): Territory => ({
  analyzed: true,
  coast: [
    [
      [
        [-40, -40],
        [40, -40],
        [40, 40],
        [-40, 40],
        [-40, -40],
      ],
    ],
  ],
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

describe("3D coastal trade", () => {
  it("builds only a water-level lane, with nothing built at its harbors, reuses geometry, and disposes replaced routes", () => {
    const data: AtlasData = {
      coverage: "test",
      fileEdges: [],
      generatedAt: "test",
      height: 300,
      packageLayers: {},
      placement: { dominantShare: 0.6, labelled: [], places: {} },
      routes: [
        {
          consumerFiles: [],
          from: "a",
          sharedConcepts: 0,
          supplierFiles: [],
          to: "b",
          weight: 20,
        },
      ],
      territories: [island("a", -120), island("b", 120)],
      width: 400,
    };
    const routes = createTradeNavigation(data)();
    const layer = createTradeLayer(data);
    layer.setRoutes(routes);
    // One lane per route and nothing else: the ports' warehouses are gone.
    expect(layer.group.children).toHaveLength(routes.length);
    const lane = layer.group.children.find((c) => c instanceof Mesh);
    if (
      !(lane instanceof Mesh && lane.material instanceof MeshBasicNodeMaterial)
    ) {
      throw new Error("Missing sea lane");
    }
    const geometry: unknown = lane.geometry;
    if (!(geometry instanceof BufferGeometry)) {
      throw new Error("Missing lane geometry");
    }
    const positions: unknown = geometry.getAttribute("position");
    if (!(positions instanceof BufferAttribute)) {
      throw new Error("Missing lane positions");
    }
    for (let i = 0; i < positions.count; i += 1) {
      expect(positions.getZ(i)).toBeCloseTo(0.08);
    }
    expect(lane.material.colorNode).not.toBeNull();
    expect(lane.material.opacityNode).not.toBeNull();
    expect(lane.material.transparent).toBe(true);
    expect(lane.material.depthWrite).toBe(false);
    const lengths: unknown = geometry.getAttribute("routeLength");
    if (!(lengths instanceof BufferAttribute)) {
      throw new Error("Missing route length");
    }
    expect(lengths.getX(0)).toBeGreaterThan(0);
    expect(lengths.count).toBe(positions.count);
    layer.setRoutes(routes);
    expect(layer.group.children).toContain(lane);
    const dispose = vi.spyOn(geometry, "dispose");
    layer.setRoutes([]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(layer.group.children).toHaveLength(0);
    layer.dispose();
  });
});
