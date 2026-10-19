import { Mesh } from "three";
import { expect, it } from "vitest";
import { createViewState } from "../../src/web/scene/view-state";
import { createWireframeLayer } from "../../src/web/scene/wireframe-layer";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import {
  defaultSceneComposition,
  detailToggles,
  isSceneLayerVisible,
  sceneCompositionPresets,
} from "../../src/web/settings/scene-composition";
import { chartSeaBounds } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

it("hides the wireframe by default, outside the app bar and every preset", () => {
  expect(isSceneLayerVisible(defaultSceneComposition, "wireframe")).toBe(false);
  expect(
    detailToggles.flatMap(({ layers }) => layers as readonly string[])
  ).not.toContain("wireframe");
  for (const preset of sceneCompositionPresets) {
    expect(preset.layers).not.toContain("wireframe");
  }
});

it("builds the hull's rings only once shown, over the emanation's extent, and releases them on dispose", async () => {
  const data = await loadSpyglass();
  const extent = chartSeaBounds(data);
  const layer = createWireframeLayer({ data, extent });
  expect(layer.group?.children).toHaveLength(0);
  const view = { height: 600, pixelsPerUnit: 1, width: 800, x: 0, y: 0 };
  const state = createViewState(data, defaultChartSettings);
  // The composition updates only a shown layer; its first update builds.
  layer.update?.(view, state, 0);
  const rings = layer.rings();
  expect(layer.group?.children).toEqual([rings.mesh]);
  layer.update?.(view, state, 1);
  expect(layer.rings()).toBe(rings);
  expect(rings.mesh).toBeInstanceOf(Mesh);
  const { material } = rings.mesh;
  if (Array.isArray(material)) {
    throw new Error("The rings have one material");
  }
  expect(material.transparent).toBe(true);
  expect(material.depthWrite).toBe(false);
  rings.mesh.geometry.computeBoundingBox();
  const box = rings.mesh.geometry.boundingBox;
  expect((box?.max.x ?? 0) - (box?.min.x ?? 0)).toBeCloseTo(extent.width, -1);
  expect((box?.max.y ?? 0) - (box?.min.y ?? 0)).toBeCloseTo(extent.height, -1);
  const released: string[] = [];
  rings.mesh.geometry.addEventListener("dispose", () =>
    released.push("geometry")
  );
  material.addEventListener("dispose", () => released.push("material"));
  layer.dispose();
  expect(released.toSorted()).toEqual(["geometry", "material"]);
});
