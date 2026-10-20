import { BufferAttribute, Mesh } from "three";
import { expect, it } from "vitest";
import { defaultRingWaveSettings } from "../../src/lib/visualization/ring-waves";
import { createClock } from "../../src/web/scene/clock";
import { sceneAnimating } from "../../src/web/scene/frame-render";
import { createLayerComposition } from "../../src/web/scene/layer-composition";
import { createRingWavesLayer } from "../../src/web/scene/ring-waves";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { sceneCompositionPresets } from "../../src/web/settings/scene-composition";
import { chartSeaBounds, type InkView } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

const view: InkView = {
  height: 600,
  pixelsPerUnit: 0.8,
  width: 800,
  x: 0,
  y: 0,
};

async function fixture() {
  const data = await loadSpyglass();
  const clock = createClock(0);
  const layer = createRingWavesLayer({
    clock,
    data,
    extent: chartSeaBounds(data),
  });
  const state = createViewState(data, defaultChartSettings);
  return { clock, layer, state };
}

const geologyPreset = sceneCompositionPresets.find(
  ({ id }) => id === "geology"
);

it("hides the waves and builds nothing while the geology preview is hidden, as it is by default", async () => {
  const { layer, state } = await fixture();
  const composition = createLayerComposition([layer]);
  composition.sync(state);
  expect(layer.enabled?.(state)).toBe(false);
  expect(composition.enabled(layer)).toBe(false);
  expect(layer.group?.visible).toBe(false);
  expect(sceneAnimating([layer], { matches: false }, composition.enabled)).toBe(
    false
  );
  composition.update(view, state, 0, (_layer, update) => update());
  expect(layer.group?.children).toHaveLength(0);
  expect(layer.stats?.()).toEqual({});
});

it("shows and animates the waves with the geology preview, and stills them under reduced motion", async () => {
  const { layer, state } = await fixture();
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: [...(geologyPreset?.layers ?? [])] },
  };
  const composition = createLayerComposition([layer]);
  composition.sync(state);
  expect(composition.enabled(layer)).toBe(true);
  expect(layer.group?.visible).toBe(true);
  expect(sceneAnimating([layer], { matches: false }, composition.enabled)).toBe(
    true
  );
  expect(sceneAnimating([layer], { matches: true }, composition.enabled)).toBe(
    false
  );
  composition.update(view, state, 0, (_layer, update) => update());
  expect(layer.group?.children).toHaveLength(1);
  expect(layer.stats?.().waves).toBeGreaterThan(50);
});

it("builds one transparent ribbon mesh once, and an update only writes the view's uniforms", async () => {
  const { layer, state } = await fixture();
  layer.update?.(view, state, 0);
  const built = layer.waves();
  expect(built.mesh).toBeInstanceOf(Mesh);
  const { geometry, material } = built.mesh;
  if (Array.isArray(material)) {
    throw new Error("The waves have one material");
  }
  expect(material.transparent).toBe(true);
  expect(material.depthWrite).toBe(false);
  const vertices = geometry.getAttribute("position").count;
  expect(vertices).toBe(built.count * 2 * defaultRingWaveSettings.samples);
  for (const name of [
    "waveStart",
    "waveEnd",
    "waveTangents",
    "waveCrest",
    "waveTiming",
  ]) {
    expect(geometry.getAttribute(name).count).toBe(vertices);
  }
  const attributes = Object.values(geometry.attributes);
  // Each attribute's upload count: an update that rewrote one would raise it.
  const uploads = () =>
    attributes.map((attribute) =>
      attribute instanceof BufferAttribute ? attribute.version : -1
    );
  const versions = uploads();
  layer.update?.({ ...view, pixelsPerUnit: 2.5, tilt: 0.4 }, state, 5);
  expect(layer.waves()).toBe(built);
  expect(built.mesh.geometry).toBe(geometry);
  expect(Object.values(geometry.attributes)).toEqual(attributes);
  expect(uploads()).toEqual(versions);
  expect(built.uniforms.pixelsPerUnit.value).toBe(2.5);
  expect(built.uniforms.squash.value).toBeCloseTo(Math.cos(0.4));
});

it("releases the geometry and material on dispose", async () => {
  const { layer, state } = await fixture();
  layer.update?.(view, state, 0);
  const { mesh } = layer.waves();
  const released: string[] = [];
  mesh.geometry.addEventListener("dispose", () => released.push("geometry"));
  const { material } = mesh;
  if (Array.isArray(material)) {
    throw new Error("The waves have one material");
  }
  material.addEventListener("dispose", () => released.push("material"));
  layer.dispose();
  expect(released.toSorted()).toEqual(["geometry", "material"]);
});
