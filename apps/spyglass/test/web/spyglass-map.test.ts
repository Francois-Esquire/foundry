// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachPointer } from "../../src/web/interaction/pointer";
import { createSpyglassScene } from "../../src/web/scene/scene";
import { SpyglassMap } from "../../src/web/ui/spyglass-map";
import { createSpyglassState } from "../../src/web/ui/spyglass-state";
import { withReadings } from "../helpers/frames";
import { loadSpyglass } from "../helpers/reference-spyglass";

/** The domain the tests choose: "shapes", declared by the single workspace's frame. */
const shapes = { frame: "", name: "shapes" };

vi.mock("../../src/web/interaction/pointer", () => ({
  attachPointer: vi.fn(() => ({ detach: vi.fn() })),
}));
vi.mock("../../src/web/scene/scene", () => ({
  createSpyglassScene: vi.fn((host: HTMLElement) => {
    const canvas = document.createElement("canvas");
    host.append(canvas);
    return {
      apply: vi.fn(),
      captureView: vi.fn(() => ({ pixels: 2, x: 10, y: 20 })),
      dispose: vi.fn(() => canvas.remove()),
      focus: vi.fn(),
      getRenderStatus: vi.fn(() => ({
        adapted: false,
        backend: "webgl" as const,
        failure: null,
        frameMs: null,
        globalIlluminationAvailable: false,
        postProcessing: true,
        quality: "medium" as const,
      })),
      restoreView: vi.fn(),
    };
  }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]) },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

it("keeps the scene alive across state and callback changes, including StrictMode", async () => {
  const state = createSpyglassState(await loadSpyglass());
  const onSelect = vi.fn();
  const onHover = vi.fn();
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(SpyglassMap, { onSelect, state })
      )
    );
  });
  expect(createSpyglassScene).toHaveBeenCalledTimes(1);
  const canvas = container.querySelector("canvas");
  const nextSelect = vi.fn();
  const [territory] = state.data.territories;
  assert(territory);
  const selection = { territory };
  const next = {
    ...state,
    chartSettings: { ...state.chartSettings, contours: true },
    domain: shapes,
    hover: selection,
    selection,
    showConnections: true,
  };
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(SpyglassMap, {
          onHover,
          onSelect: nextSelect,
          state: next,
        })
      )
    );
  });
  const [result] = vi.mocked(createSpyglassScene).mock.results;
  assert(result);
  const scene = result.value;
  expect(createSpyglassScene).toHaveBeenCalledTimes(1);
  expect(container.querySelector("canvas")).toBe(canvas);
  // The whole snapshot reaches the scene: the settings, the connections and
  // the chosen domain beside the selection, not as one.
  expect(scene.apply).toHaveBeenLastCalledWith(next);
  // The pointer is attached to the scene once, and its callbacks reach the
  // latest handlers.
  expect(attachPointer).toHaveBeenCalledTimes(1);
  const [pointerCall] = vi.mocked(attachPointer).mock.calls;
  assert(pointerCall);
  expect(pointerCall[0]).toBe(scene);
  pointerCall[1].onSelect(selection);
  pointerCall[1].onHover(selection);
  expect(nextSelect).toHaveBeenCalledWith(selection);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onHover).toHaveBeenCalledWith(selection);
  await act(() => root.unmount());
  const [pointer] = vi.mocked(attachPointer).mock.results;
  assert(pointer);
  expect(pointer.value.detach).toHaveBeenCalledTimes(1);
  expect(scene.dispose).toHaveBeenCalledTimes(1);
  // The pointer lets go before the scene is torn down.
  expect(pointer.value.detach.mock.invocationCallOrder[0]).toBeLessThan(
    scene.dispose.mock.invocationCallOrder[0] ?? 0
  );
  expect(container.querySelector("canvas")).toBeNull();
});

it("restores the camera and overlays after a geometry rebuild", async () => {
  const state = createSpyglassState(await loadSpyglass());
  await act(async () => root.render(createElement(SpyglassMap, { state })));
  const [firstResult] = vi.mocked(createSpyglassScene).mock.results;
  assert(firstResult);
  const first = firstResult.value;
  const next = {
    ...state,
    chartSettings: {
      ...state.chartSettings,
      layers: { ...state.chartSettings.layers, land: true },
    },
    domain: shapes,
    territoryLayout: state.data.territories[0] ?? null,
  };
  await act(async () =>
    root.render(createElement(SpyglassMap, { state: next }))
  );
  const [, secondResult] = vi.mocked(createSpyglassScene).mock.results;
  assert(secondResult);
  const second = secondResult.value;
  expect(first.dispose).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll("canvas")).toHaveLength(1);
  expect(second.restoreView).toHaveBeenCalledWith({ pixels: 2, x: 10, y: 20 });
  expect(second.apply).toHaveBeenCalledWith(next);
  // The saved camera lands after the state, as the state's relayout moves it.
  expect(second.apply.mock.invocationCallOrder[0]).toBeLessThan(
    second.restoreView.mock.invocationCallOrder[0] ?? 0
  );
});

it("does not create a scene after unmount while fonts are loading", async () => {
  const { promise: pending, resolve: finish } =
    Promise.withResolvers<FontFace[]>();
  vi.mocked(document.fonts.load).mockReturnValue(pending);
  const state = createSpyglassState(await loadSpyglass());
  await act(async () => root.render(createElement(SpyglassMap, { state })));
  await act(() => root.unmount());
  await act(async () => {
    finish([]);
  });
  expect(createSpyglassScene).not.toHaveBeenCalled();
});

it("builds the scene for a reader unless the session is a developer's", async () => {
  const data = await loadSpyglass();
  await act(async () =>
    root.render(
      createElement(SpyglassMap, { state: createSpyglassState(data) })
    )
  );
  await act(async () =>
    root.render(
      createElement(SpyglassMap, { state: createSpyglassState(data, true) })
    )
  );
  expect(
    vi
      .mocked(createSpyglassScene)
      .mock.calls.map(([, , options]) => options.developer)
  ).toEqual([false, true]);
});

it("applies sea trade routes through apply, without building a new scene", async () => {
  const state = createSpyglassState(await loadSpyglass());
  await act(async () => root.render(createElement(SpyglassMap, { state })));
  const next = {
    ...state,
    chartSettings: { ...state.chartSettings, trade: true },
  };
  await act(async () =>
    root.render(createElement(SpyglassMap, { state: next }))
  );
  expect(createSpyglassScene).toHaveBeenCalledTimes(1);
  const [result] = vi.mocked(createSpyglassScene).mock.results;
  assert(result);
  expect(result.value.apply).toHaveBeenLastCalledWith(next);
});

it("hands readings that arrive after load to the scene it has, without building another", async () => {
  const state = createSpyglassState(await loadSpyglass());
  await act(async () => root.render(createElement(SpyglassMap, { state })));
  const [result] = vi.mocked(createSpyglassScene).mock.results;
  assert(result);
  const scene = await result.value;
  // Built from the laid-out spyglass, given the same spyglass to draw from.
  expect(vi.mocked(createSpyglassScene).mock.calls[0]?.[1]).toBe(
    state.geometry
  );
  expect(scene.apply).toHaveBeenLastCalledWith(state);
  const read = {
    ...state,
    data: withReadings(state.data, {
      proximity: {
        apart: { coChanges: [], files: [] },
        close: [],
        labelled: ["island"],
      },
    }),
  };
  await act(async () =>
    root.render(createElement(SpyglassMap, { state: read }))
  );
  expect(createSpyglassScene).toHaveBeenCalledTimes(1);
  expect(scene.apply).toHaveBeenLastCalledWith(read);
});
