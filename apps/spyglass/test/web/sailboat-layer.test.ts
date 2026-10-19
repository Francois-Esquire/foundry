import {
  type BufferGeometry,
  LineSegments,
  type Material,
  Mesh,
  Vector3,
} from "three";
import { expect, it, vi } from "vitest";
import { boatRadius } from "../../src/web/layout/sailing";
import { createSailboatLayer } from "../../src/web/scene/sailboat-layer";

it("places the boat in chart coordinates with a consistent heading and retains idle resources", () => {
  const layer = createSailboatLayer();
  const [vessel] = layer.group?.children ?? [];
  if (!vessel) {
    throw new Error("The sailboat needs its vessel group.");
  }
  expect(vessel.visible).toBe(false);
  const resources = [...vessel.children];
  layer.setPose({ heading: 0, x: 10, y: 20 });
  expect(vessel.position.toArray()).toEqual([10, -20, 0]);
  vessel.updateMatrixWorld();
  const bowDirection = new Vector3(0, 1, 0).transformDirection(
    vessel.matrixWorld
  );
  expect(bowDirection.x).toBeCloseTo(1);
  expect(bowDirection.y).toBeCloseTo(0);
  layer.setPose({ heading: -Math.PI / 2, x: 12, y: 18 });
  expect(vessel.rotation.z).toBe(0);
  expect(vessel.children).toEqual(resources);
  expect(layer.animating?.() ?? false).toBe(false);
  layer.setPose(null);
  expect(vessel.visible).toBe(false);
  layer.dispose();
});

it("keeps the full hull inside its collision radius and disposes shared resources exactly once", () => {
  const layer = createSailboatLayer();
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  layer.group?.updateWorldMatrix(true, true);
  layer.group?.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof LineSegments)) {
      return;
    }
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      materials.add(material);
    }
    const positions = object.geometry.getAttribute("position");
    for (let index = 0; index < positions.count; index += 1) {
      const point = new Vector3()
        .fromBufferAttribute(positions, index)
        .applyMatrix4(object.matrixWorld);
      expect(Math.hypot(point.x, point.y)).toBeLessThan(boatRadius);
    }
  });
  const disposed = [...geometries, ...materials].map((resource) => {
    const listener = vi.fn();
    resource.addEventListener("dispose", listener);
    return listener;
  });
  layer.dispose();
  for (const listener of disposed) {
    expect(listener).toHaveBeenCalledOnce();
  }
});
