// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAtlasScene } from "../../src/web/scene/scene";
import { AtlasMap } from "../../src/web/ui/atlas-map";
import { createAtlasState } from "../../src/web/ui/atlas-state";
import { loadAtlas } from "../helpers/reference-atlas";

vi.mock("../../src/web/scene/scene", () => ({
  createAtlasScene: vi.fn((host: HTMLElement) => {
    const canvas = document.createElement("canvas");
    host.append(canvas);
    return {
      captureView: vi.fn(() => ({ pixels: 2, x: 10, y: 20 })),
      configure: vi.fn(),
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
      setBelonging: vi.fn(),
      setConnections: vi.fn(),
      setDomain: vi.fn(),
      setLegendHeight: vi.fn(),
      setResponsibility: vi.fn(),
      setTerritoryLayout: vi.fn(),
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
  const state = createAtlasState(await loadAtlas());
  const onSelect = vi.fn();
  const onHover = vi.fn();
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(AtlasMap, { onSelect, state })
      )
    );
  });
  expect(createAtlasScene).toHaveBeenCalledTimes(1);
  const canvas = container.querySelector("canvas");
  const nextSelect = vi.fn();
  const [territory] = state.data.territories;
  assert(territory);
  const selection = { territory };
  const next = {
    ...state,
    chartSettings: { ...state.chartSettings, contours: true },
    domain: "shapes",
    hover: selection,
    selection,
    showConnections: true,
  };
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(AtlasMap, {
          onHover,
          onSelect: nextSelect,
          state: next,
        })
      )
    );
  });
  const [result] = vi.mocked(createAtlasScene).mock.results;
  assert(result);
  const scene = result.value;
  expect(createAtlasScene).toHaveBeenCalledTimes(1);
  expect(container.querySelector("canvas")).toBe(canvas);
  expect(scene.configure).toHaveBeenLastCalledWith(next.chartSettings);
  expect(scene.setConnections).toHaveBeenLastCalledWith(true);
  // A chosen domain reaches the scene beside the selection, not as one.
  expect(scene.setDomain).toHaveBeenLastCalledWith("shapes");
  const [call] = vi.mocked(createAtlasScene).mock.calls;
  assert(call);
  call[2].onSelect(selection);
  call[2].onHover(selection);
  expect(nextSelect).toHaveBeenCalledWith(selection);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onHover).toHaveBeenCalledWith(selection);
  await act(() => root.unmount());
  expect(scene.dispose).toHaveBeenCalledTimes(1);
  expect(container.querySelector("canvas")).toBeNull();
});

it("restores the camera and overlays after a geometry rebuild", async () => {
  const state = createAtlasState(await loadAtlas());
  await act(async () => root.render(createElement(AtlasMap, { state })));
  const [firstResult] = vi.mocked(createAtlasScene).mock.results;
  assert(firstResult);
  const first = firstResult.value;
  const next = {
    ...state,
    chartSettings: {
      ...state.chartSettings,
      layers: { ...state.chartSettings.layers, land: true },
    },
    domain: "shapes",
    territoryLayout: state.data.territories[0] ?? null,
  };
  await act(async () => root.render(createElement(AtlasMap, { state: next })));
  const [, secondResult] = vi.mocked(createAtlasScene).mock.results;
  assert(secondResult);
  const second = secondResult.value;
  expect(first.dispose).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll("canvas")).toHaveLength(1);
  expect(second.restoreView).toHaveBeenCalledWith({ pixels: 2, x: 10, y: 20 });
  expect(second.setDomain).toHaveBeenCalledWith("shapes");
  expect(second.setTerritoryLayout).toHaveBeenCalledWith(next.territoryLayout);
});

it("does not create a scene after unmount while fonts are loading", async () => {
  const { promise: pending, resolve: finish } =
    Promise.withResolvers<FontFace[]>();
  vi.mocked(document.fonts.load).mockReturnValue(pending);
  const state = createAtlasState(await loadAtlas());
  await act(async () => root.render(createElement(AtlasMap, { state })));
  await act(() => root.unmount());
  await act(async () => {
    finish([]);
  });
  expect(createAtlasScene).not.toHaveBeenCalled();
});

it("builds the scene for a reader unless the session is a developer's", async () => {
  const data = await loadAtlas();
  await act(async () =>
    root.render(createElement(AtlasMap, { state: createAtlasState(data) }))
  );
  await act(async () =>
    root.render(
      createElement(AtlasMap, { state: createAtlasState(data, true) })
    )
  );
  expect(
    vi
      .mocked(createAtlasScene)
      .mock.calls.map(([, , options]) => options.developer)
  ).toEqual([false, true]);
});

it("applies sea trade routes through configure, without building a new scene", async () => {
  const state = createAtlasState(await loadAtlas());
  await act(async () => root.render(createElement(AtlasMap, { state })));
  const next = {
    ...state,
    chartSettings: { ...state.chartSettings, trade: true },
  };
  await act(async () => root.render(createElement(AtlasMap, { state: next })));
  expect(createAtlasScene).toHaveBeenCalledTimes(1);
  const [result] = vi.mocked(createAtlasScene).mock.results;
  assert(result);
  expect(result.value.configure).toHaveBeenLastCalledWith(next.chartSettings);
});
