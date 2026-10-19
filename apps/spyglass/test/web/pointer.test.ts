// @vitest-environment happy-dom
import { Vector3 } from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SpyglassData, Territory } from "../../src/web/data/types";
import {
  attachPointer,
  type PointerScene,
} from "../../src/web/interaction/pointer";
import type { BelongingLayer } from "../../src/web/layout/belonging";
import type { Landmark } from "../../src/web/layout/landmarks";
import type { NaturalFeature } from "../../src/web/layout/natural-feature-inspection";
import {
  createViewState,
  type ViewState,
} from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { loadSpyglass } from "../helpers/reference-spyglass";

/**
 * A scene whose camera is the identity: a page point (x, y) is the chart
 * point (x, -y), so a test addresses an island by its own coordinates.
 */
function fakeScene(data: SpyglassData) {
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({ height: 400, left: 0, top: 0, width: 600 }) as DOMRect;
  document.body.append(canvas);
  const state: ViewState = createViewState(data, defaultChartSettings);
  const scene = {
    camera: {
      chartPoint: (page) => new Vector3(page.clientX, -page.clientY, 0),
      view: () => ({ height: 400, pixelsPerUnit: 2, width: 600, x: 0, y: 0 }),
    },
    canvas,
    data,
    render: vi.fn(),
    setBelongingHover: vi.fn((hover) => {
      state.belongingHover = hover;
    }),
    setHoverResolver: vi.fn(),
    setLabelActivation: vi.fn(),
    state,
    terrain: [],
  } satisfies PointerScene;
  return { canvas, scene, state };
}

const pointer = (
  canvas: HTMLCanvasElement,
  type: string,
  at: { x: number; y: number },
  buttons = 0
) =>
  canvas.dispatchEvent(
    new MouseEvent(type, { buttons, clientX: at.x, clientY: at.y })
  );

let island: Territory;
let chart: SpyglassData;
beforeEach(async () => {
  chart = await loadSpyglass();
  const found = chart.territories.find((item) => item.files.length > 0);
  if (!found) {
    throw new Error("Missing a populated island");
  }
  island = found;
  vi.useFakeTimers();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: true,
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

it("selects the place under a click, not under a drag, and hears a click at sea only while something is selected", () => {
  const { canvas, scene, state } = fakeScene(chart);
  const onSelect = vi.fn();
  attachPointer(scene, { onHover: vi.fn(), onSelect });
  const at = { x: island.x, y: island.y };
  pointer(canvas, "pointerdown", at);
  pointer(canvas, "pointerup", at);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect.mock.calls[0]?.[0]?.territory.id).toBe(island.id);
  pointer(canvas, "pointerdown", at);
  pointer(canvas, "pointerup", { x: at.x + 40, y: at.y });
  expect(onSelect).toHaveBeenCalledTimes(1);
  const sea = { x: chart.width * 4, y: chart.height * 4 };
  pointer(canvas, "pointerdown", sea);
  pointer(canvas, "pointerup", sea);
  expect(onSelect).toHaveBeenCalledTimes(1);
  state.selected = island.id;
  pointer(canvas, "pointerdown", sea);
  pointer(canvas, "pointerup", sea);
  expect(onSelect).toHaveBeenLastCalledWith(null);
});

it("previews the place the pointer rests on after 90 ms, once per place, and clears it on leaving", () => {
  const { canvas, scene } = fakeScene(chart);
  const onHover = vi.fn();
  attachPointer(scene, { onHover, onSelect: vi.fn() });
  pointer(canvas, "pointermove", { x: island.x, y: island.y });
  expect(canvas.style.cursor).toBe("pointer");
  expect(onHover).not.toHaveBeenCalled();
  vi.advanceTimersByTime(89);
  expect(onHover).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onHover).toHaveBeenCalledTimes(1);
  expect(onHover.mock.calls[0]?.[0]?.territory.id).toBe(island.id);
  // Resting on the same place again previews nothing new.
  pointer(canvas, "pointermove", { x: island.x + 1, y: island.y });
  vi.advanceTimersByTime(90);
  expect(onHover).toHaveBeenCalledTimes(1);
  // A pan follows the pointer without previewing.
  pointer(canvas, "pointermove", { x: chart.width * 4, y: 0 }, 1);
  vi.advanceTimersByTime(90);
  expect(onHover).toHaveBeenCalledTimes(1);
  pointer(canvas, "pointerleave", { x: 0, y: 0 });
  expect(onHover).toHaveBeenLastCalledWith(null);
});

it("emphasises the hovered region of a belonging layer, and lets the preview go when another layer is applied", () => {
  const { canvas, scene, state } = fakeScene(chart);
  // The layer focuses a feature, so leaving has a hover to lift.
  const focus: NaturalFeature = {
    kind: "landmark",
    landmark: { basis: "commons" } as Partial<Landmark> as Landmark,
  };
  const belonging: BelongingLayer = {
    featureFocus: focus,
    regions: [],
    territory: island,
  };
  state.belonging = belonging;
  attachPointer(scene, { onHover: vi.fn(), onSelect: vi.fn() });
  pointer(canvas, "pointermove", { x: island.x, y: island.y });
  vi.advanceTimersByTime(90);
  // Reduced motion: the emphasis is up at once.
  expect(scene.setBelongingHover).toHaveBeenCalledTimes(1);
  expect(state.belongingHover?.emphasis).toBe(1);
  // Leaving lifts the hover but keeps the emphasis it reached.
  pointer(canvas, "pointerleave", { x: 0, y: 0 });
  expect(state.belongingHover).toEqual({ emphasis: 1 });
  // A fresh layer applied by the scene: the pending preview over the old one ends.
  pointer(canvas, "pointermove", { x: island.x, y: island.y });
  state.belonging = { regions: [], territory: island };
  state.belongingHover = null;
  vi.advanceTimersByTime(90);
  expect(scene.setBelongingHover).toHaveBeenCalledTimes(2);
  expect(state.belongingHover).toBeNull();
});

it("hits a wreck before the land, and detaches cleanly", () => {
  const wreck = {
    id: "lost",
    label: "lost",
    lastObserved: "2026-01-01",
    x: 500,
    y: 500,
  };
  const { canvas, scene } = fakeScene({ ...chart, formerPackages: [wreck] });
  const onWreck = vi.fn();
  const onSelect = vi.fn();
  const attached = attachPointer(scene, {
    onHover: vi.fn(),
    onSelect,
    onWreck,
  });
  pointer(canvas, "pointerdown", { x: 500, y: 500 });
  pointer(canvas, "pointerup", { x: 500, y: 500 });
  expect(onWreck).toHaveBeenLastCalledWith(wreck, true);
  expect(onSelect).not.toHaveBeenCalled();
  expect(scene.setHoverResolver).toHaveBeenCalledWith(expect.any(Function));
  attached.detach();
  expect(scene.setHoverResolver).toHaveBeenLastCalledWith(null);
  pointer(canvas, "pointerdown", { x: 500, y: 500 });
  pointer(canvas, "pointerup", { x: 500, y: 500 });
  expect(onWreck).toHaveBeenCalledTimes(1);
});

it("inks the island under the resting pointer through the repaint's resolver, never the selected one", () => {
  const { canvas, scene, state } = fakeScene(chart);
  attachPointer(scene, { onHover: vi.fn(), onSelect: vi.fn() });
  const resolve = vi.mocked(scene.setHoverResolver).mock.calls[0]?.[0];
  if (!resolve) {
    throw new Error("No hover resolver");
  }
  // The resolver takes nothing: the frame's labels are read off the state.
  expect(resolve()).toBeNull();
  pointer(canvas, "pointermove", { x: island.x, y: island.y });
  expect(scene.render).toHaveBeenCalledTimes(1);
  expect(resolve()?.id).toBe(island.id);
  state.selected = island.id;
  expect(resolve()).toBeNull();
  pointer(canvas, "pointerleave", { x: 0, y: 0 });
  expect(resolve()).toBeNull();
});
