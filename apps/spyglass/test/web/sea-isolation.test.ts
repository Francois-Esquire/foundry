import { expect, it, vi } from "vitest";
import { createSeaLayer } from "../../src/web/scene/sea-layer";
import { createViewState } from "../../src/web/scene/view-state";
import { createWaterMaterial } from "../../src/web/scene/water-material";
import type { WeatherNodes } from "../../src/web/scene/weather";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { loadSpyglass } from "../helpers/reference-spyglass";

vi.mock("../../src/web/scene/water-material", async () => {
  const { MeshBasicMaterial } = await import("three");
  return {
    createWaterMaterial: vi.fn(() => ({
      dispose: vi.fn(),
      material: new MeshBasicMaterial(),
      setWreckReveal: vi.fn(),
    })),
  };
});

vi.mock("../../src/web/layout/ocean-field", () => ({
  oceanField: () => ({ rims: [] }),
  rimField: () => ({}),
}));

it("closes the water's wreck openings during ocean isolation and restores them with wrecks", async () => {
  const data = await loadSpyglass();
  const state = createViewState(data, defaultChartSettings);
  const weather: WeatherNodes = {
    cloudLight: vi.fn(),
    rimSurf: vi.fn(),
  };
  const sea = createSeaLayer({
    chart: data,
    coasts: [],
    sea: data,
    shore: {
      distances: new Float32Array(),
      height: 0,
      land: new Uint8Array(),
      outside: new Float32Array(),
      rims: [],
      scale: 1,
      width: 0,
    },
    weather,
  });
  const water = vi.mocked(createWaterMaterial).mock.results[0]?.value;
  const view = { height: 600, pixelsPerUnit: 3, width: 800, x: 0, y: 0 };
  state.settings = {
    ...state.settings,
    composition: { hidden: [], solo: ["sea"] },
  };
  sea.update?.(view, state, 0);
  expect(water.setWreckReveal).toHaveBeenLastCalledWith(3, false);
  state.settings = { ...state.settings, composition: { hidden: [], solo: [] } };
  sea.update?.(view, state, 1);
  expect(water.setWreckReveal).toHaveBeenLastCalledWith(3, true);
  sea.dispose();
});
