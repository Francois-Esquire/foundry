import { InstancedMesh, Matrix4, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { createArchitectureLayer } from "../../src/web/scene/architecture-layer";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import type { InkView } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("retains batches, follows actual camera progress and becomes empty at the atlas endpoint", async () => {
  const data = await loadSpyglass();
  const layer = createArchitectureLayer(data);
  const state = createViewState(data, {
    ...defaultChartSettings,
    presentation: 1,
  });
  const view: InkView = {
    height: 600,
    pixelsPerUnit: 4,
    presentation: 0.5,
    width: 800,
    x: 0,
    y: 0,
  };
  const meshes =
    layer.group?.children.filter(
      (child): child is InstancedMesh => child instanceof InstancedMesh
    ) ?? [];
  expect(meshes).toHaveLength(5);
  layer.update?.(view, state, 0);
  const walls = meshes.find((mesh) => mesh.name === "walls");
  expect(walls?.count).toBeGreaterThan(100);
  const matrix = new Matrix4();
  walls?.getMatrixAt(0, matrix);
  const halfHeight = new Vector3().setFromMatrixScale(matrix).z;
  layer.update?.({ ...view, presentation: 1 }, state, 1);
  walls?.getMatrixAt(0, matrix);
  expect(new Vector3().setFromMatrixScale(matrix).z).toBeCloseTo(
    halfHeight * 2
  );
  const versions = meshes.map((mesh) => mesh.instanceMatrix.version);
  layer.update?.({ ...view, presentation: 1, x: 10 }, state, 2);
  expect(meshes.map((mesh) => mesh.instanceMatrix.version)).toEqual(versions);
  expect(layer.group?.children).toEqual(meshes);
  layer.update?.({ ...view, presentation: 0 }, state, 3);
  expect(meshes.every((mesh) => mesh.count === 0)).toBe(true);
  const dispose = vi.fn();
  walls?.geometry.addEventListener("dispose", dispose);
  layer.dispose();
  expect(dispose).toHaveBeenCalledOnce();
});
