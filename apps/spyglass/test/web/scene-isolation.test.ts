import { Group, MeshBasicMaterial } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { createBelongingReveal } from "../../src/web/scene/belonging-reveal";
import { createClock } from "../../src/web/scene/clock";
import { sceneAnimating } from "../../src/web/scene/frame-render";
import type { SceneLayer } from "../../src/web/scene/handle";
import { createLayerComposition } from "../../src/web/scene/layer-composition";
import { markLayers } from "../../src/web/scene/marks/layers";
import { createReliefLayer } from "../../src/web/scene/relief-layer";
import { createViewState } from "../../src/web/scene/view-state";
import { createWeatherLayer } from "../../src/web/scene/weather";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import {
  isSceneLayerVisible,
  sceneLayerDefinitions,
} from "../../src/web/settings/scene-composition";
import type { InkView } from "../../src/web/view/chart-view";
import { loadSpyglass } from "../helpers/reference-spyglass";

const view: InkView = {
  height: 600,
  pixelsPerUnit: 1,
  width: 800,
  x: 0,
  y: 0,
};

it("isolates execution and restores previous visibility without rebuilding layers or losing selection", async () => {
  const state = createViewState(await loadSpyglass(), defaultChartSettings);
  state.selected = state.drawingData.territories[0]?.id ?? null;
  const selection = state.selected;
  const sea: SceneLayer = {
    animating: () => true,
    dispose: vi.fn(),
    group: new Group(),
    id: "sea",
    kind: "layer",
    update: vi.fn(),
  };
  const files: SceneLayer = {
    dispose: vi.fn(),
    group: new Group(),
    id: "files",
    kind: "marks",
    update: vi.fn(),
  };
  const labels: SceneLayer = {
    dispose: vi.fn(),
    id: "labels",
    kind: "labels",
    setVisible: vi.fn(),
    update: vi.fn(),
  };
  const layers = [sea, files, labels];
  const composition = createLayerComposition(layers);
  const measure = (_layer: SceneLayer, update: () => void) => update();
  state.settings = {
    ...state.settings,
    composition: { hidden: ["files"], solo: [] },
  };
  composition.sync(state);
  composition.update(view, state, 0, measure);
  expect(sea.update).toHaveBeenCalledTimes(1);
  expect(files.update).not.toHaveBeenCalled();
  expect(labels.update).toHaveBeenCalledTimes(1);

  state.settings = {
    ...state.settings,
    composition: { hidden: ["files"], solo: ["files"] },
  };
  composition.sync(state);
  composition.update(view, state, 1, measure);
  expect(sea.group?.visible).toBe(false);
  expect(files.group?.visible).toBe(true);
  expect(sea.update).toHaveBeenCalledTimes(1);
  expect(files.update).toHaveBeenCalledTimes(1);
  expect(labels.update).toHaveBeenCalledTimes(1);
  expect(labels.setVisible).toHaveBeenLastCalledWith(false);
  expect(sceneAnimating(layers, { matches: false }, composition.enabled)).toBe(
    false
  );

  state.settings = {
    ...state.settings,
    composition: { ...state.settings.composition, solo: [] },
  };
  composition.sync(state);
  composition.update(view, state, 2, measure);
  expect(sea.group?.visible).toBe(true);
  expect(files.group?.visible).toBe(false);
  expect(labels.setVisible).toHaveBeenLastCalledWith(true);
  expect(sea.update).toHaveBeenCalledTimes(2);
  expect(state.selected).toBe(selection);
  expect(sea.dispose).not.toHaveBeenCalled();
});

it("keeps semantic gates when a layer is soloed, then updates it when the gate opens", async () => {
  const state = createViewState(await loadSpyglass(), defaultChartSettings);
  const trades: SceneLayer = {
    dispose: vi.fn(),
    enabled: (current) => current.settings.trade,
    group: new Group(),
    id: "trades",
    kind: "layer",
    update: vi.fn(),
  };
  const composition = createLayerComposition([trades]);
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: ["trades"] },
  };
  composition.sync(state);
  composition.update(view, state, 0, (_layer, update) => update());
  expect(trades.group?.visible).toBe(false);
  expect(trades.update).not.toHaveBeenCalled();
  state.settings = { ...state.settings, trade: true };
  composition.sync(state);
  composition.update(view, state, 1, (_layer, update) => update());
  expect(trades.group?.visible).toBe(true);
  expect(trades.update).toHaveBeenCalledTimes(1);
});

it("separates cliff meshes and excludes hidden terrain from selection outlines while retaining geographic data", async () => {
  const data = await loadSpyglass();
  const [territory] = data.territories;
  if (!territory) {
    throw new Error("Fixture has no territory");
  }
  const state = createViewState(data, defaultChartSettings);
  const paper = new MeshBasicMaterial();
  const relief = createReliefLayer(
    { ...data, territories: [territory] },
    paper
  );
  const surfaces = relief.meshesOf(territory.id);
  const [geometry] = relief.geometries;
  const composition = createLayerComposition([
    {
      dispose: relief.dispose,
      group: relief.group,
      id: "relief",
      kind: "layer",
    },
    { dispose: vi.fn(), group: relief.cliffs, id: "cliffs", kind: "layer" },
  ]);
  expect(surfaces.length).toBeGreaterThan(0);
  expect(relief.cliffs.children.length).toBeGreaterThan(0);
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: ["cliffs"] },
  };
  composition.sync(state);
  expect(relief.meshesOf(territory.id)).toEqual([]);
  expect(relief.cliffs.visible).toBe(true);
  expect(relief.geometries[0]).toBe(geometry);
  expect(relief.islandOf(territory)).toBe(territory);
  state.settings = { ...state.settings, composition: { hidden: [], solo: [] } };
  composition.sync(state);
  expect(relief.meshesOf(territory.id)).toBe(surfaces);
  relief.dispose();
  paper.dispose();
});

it("stills weather without visible consumers and resumes water animation on ocean isolation", async () => {
  const state = createViewState(await loadSpyglass(), defaultChartSettings);
  const visible = (id: "sea" | "relief") =>
    isSceneLayerVisible(state.settings.composition, id);
  const clock = createClock();
  const weather = createWeatherLayer(clock, () => ({
    paper: visible("relief"),
    sea: visible("sea"),
  }));
  const composition = createLayerComposition([weather]);
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: ["files"] },
  };
  composition.sync(state);
  expect(
    sceneAnimating([weather], { matches: false }, composition.enabled)
  ).toBe(false);
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: ["relief"] },
  };
  weather.configure({ clouds: false, waves: true });
  expect(
    sceneAnimating([weather], { matches: false }, composition.enabled)
  ).toBe(false);
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: ["sea"] },
  };
  expect(
    sceneAnimating([weather], { matches: false }, composition.enabled)
  ).toBe(true);
  expect(
    sceneAnimating([weather], { matches: true }, composition.enabled)
  ).toBe(false);
  weather.dispose();
  clock.dispose();
});

it("registers every mark layer for composition control", () => {
  const registered = new Set<string>(sceneLayerDefinitions.map(({ id }) => id));
  expect(markLayers.filter(({ id }) => !registered.has(id))).toEqual([]);
});

afterEach(() => vi.unstubAllGlobals());

it("applies hidden belonging without scheduling reveals and finishes an active reveal on hide", async () => {
  const data = await loadSpyglass();
  const [territory] = data.territories;
  if (!territory) {
    throw new Error("Fixture has no territory");
  }
  const state = createViewState(data, defaultChartSettings);
  const request = vi.fn(() => 1);
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  let visible = false;
  const reveal = createBelongingReveal({
    reducedMotion: { matches: false },
    render: vi.fn(),
    state,
    visible: () => visible,
  });
  const belonging = { regions: [], territory };
  reveal.set(belonging);
  expect(state.belonging).toBe(belonging);
  expect(state.belongingReveal).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  reveal.set(null);
  visible = true;
  reveal.set(belonging);
  expect(request).toHaveBeenCalledTimes(1);
  visible = false;
  reveal.finish();
  expect(cancel).toHaveBeenLastCalledWith(1);
  expect(state.belonging).toBe(belonging);
  expect(state.belongingReveal).toBeUndefined();
  reveal.dispose();
});
