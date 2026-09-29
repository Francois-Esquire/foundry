// @vitest-environment happy-dom
import assert from "node:assert/strict";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AtlasMap } from "../../src/web/atlas-map";
import { createAtlasState } from "../../src/web/atlas-state";
import { createAtlasScene } from "../../src/web/scene";
import { loadAtlas } from "../helpers/reference-atlas";

vi.mock("../../src/web/scene", () => ({
  createAtlasScene: vi.fn((host: HTMLElement) => {
    const canvas = document.createElement("canvas");
    host.append(canvas);
    return {
      captureView: vi.fn(() => ({ pixels: 2, x: 10, y: 20 })),
      configure: vi.fn(),
      dispose: vi.fn(() => canvas.remove()),
      focus: vi.fn(),
      getPlayback: vi.fn(() => ({ time: 15 })),
      restorePlayback: vi.fn(),
      restoreView: vi.fn(),
      setAtmosphere: vi.fn(),
      setBelonging: vi.fn(),
      setConnections: vi.fn(),
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
    atmosphereEnabled: true,
    chartSettings: { ...state.chartSettings, contours: true },
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
  expect(scene.setAtmosphere).toHaveBeenLastCalledWith(true);
  expect(scene.setConnections).toHaveBeenLastCalledWith(true);
  const [call] = vi.mocked(createAtlasScene).mock.calls;
  assert(call);
  call[2](selection);
  call[3](selection);
  expect(nextSelect).toHaveBeenCalledWith(selection);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onHover).toHaveBeenCalledWith(selection);
  await act(() => root.unmount());
  expect(scene.dispose).toHaveBeenCalledTimes(1);
  expect(container.querySelector("canvas")).toBeNull();
});

it("restores camera, playback, and overlays after a geometry rebuild", async () => {
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
    territoryLayout: state.data.territories[0] ?? null,
  };
  await act(async () => root.render(createElement(AtlasMap, { state: next })));
  const [, secondResult] = vi.mocked(createAtlasScene).mock.results;
  assert(secondResult);
  const second = secondResult.value;
  expect(first.dispose).toHaveBeenCalledTimes(1);
  expect(container.querySelectorAll("canvas")).toHaveLength(1);
  expect(second.restoreView).toHaveBeenCalledWith({ pixels: 2, x: 10, y: 20 });
  expect(second.restorePlayback).toHaveBeenCalledWith({ time: 15 });
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
