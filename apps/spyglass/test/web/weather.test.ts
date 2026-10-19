import { float, positionWorld } from "three/tsl";
import { expect, it } from "vitest";
import { createClock } from "../../src/web/scene/clock";
import { sceneAnimating } from "../../src/web/scene/frame-render";
import { createWeatherLayer, surfBand } from "../../src/web/scene/weather";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { sceneLayerSolo } from "../../src/web/settings/scene-composition";

it("sets the two uniforms from the reader's settings, 1 or 0", () => {
  const clock = createClock();
  const weather = createWeatherLayer(clock);
  weather.configure(defaultChartSettings);
  expect(weather.drawn.surf.value).toBe(1);
  expect(weather.drawn.drift.value).toBe(1);
  weather.configure({ ...defaultChartSettings, clouds: false, waves: true });
  expect(weather.drawn.surf.value).toBe(1);
  expect(weather.drawn.drift.value).toBe(0);
  weather.configure({ ...defaultChartSettings, clouds: false, waves: false });
  expect(weather.drawn.surf.value).toBe(0);
  expect(weather.drawn.drift.value).toBe(0);
  weather.dispose();
  clock.dispose();
});

it("animates while either decoration is on, and rests when both are off", () => {
  const weather = createWeatherLayer(createClock());
  expect(weather.id).toBe("weather");
  // Declared by the layer, for its node in the composition.
  expect(weather.kind).toBe("layer");
  expect(weather.group).toBeUndefined();
  weather.configure({ ...defaultChartSettings, clouds: true, waves: true });
  expect(weather.animating?.()).toBe(true);
  weather.configure({ ...defaultChartSettings, clouds: false, waves: true });
  expect(weather.animating?.()).toBe(true);
  weather.configure({ ...defaultChartSettings, clouds: true, waves: false });
  expect(weather.animating?.()).toBe(true);
  weather.configure({ ...defaultChartSettings, clouds: false, waves: false });
  expect(weather.animating?.()).toBe(false);
  weather.dispose();
});

it("builds the surf and the subsurface drift as nodes over the clock", () => {
  const weather = createWeatherLayer(createClock());
  const surf = weather.rimSurf(float(3), positionWorld.xy);
  const light = weather.driftLight(positionWorld.xy);
  expect(surf.isNode).toBe(true);
  expect(light.isNode).toBe(true);
  // The band lies just outside the rim: it peaks before it is gone.
  expect(surfBand.crest).toBeGreaterThan(0);
  expect(surfBand.reach).toBeGreaterThan(surfBand.crest);
  weather.dispose();
});

it("toggles apart from another scene's weather, and releases its uniforms when disposed", () => {
  const one = createWeatherLayer(createClock());
  const other = createWeatherLayer(createClock());
  one.configure({ ...defaultChartSettings, clouds: false, waves: false });
  expect(one.animating?.()).toBe(false);
  expect(other.animating?.()).toBe(true);
  expect(other.drawn.drift.value).toBe(1);
  expect(other.drawn.surf.value).toBe(1);
  expect(one.drawn.drift).not.toBe(other.drawn.drift);
  const released: string[] = [];
  for (const [name, node] of Object.entries(one.drawn)) {
    node.addEventListener("dispose", () => {
      released.push(name);
    });
  }
  one.dispose();
  expect(released.toSorted()).toEqual(["drift", "surf"]);
  other.dispose();
});

it("isolates drift and surf without changing reader preferences or their shader nodes", () => {
  const clock = createClock(0);
  const weather = createWeatherLayer(clock);
  const { drift, surf } = weather.drawn;
  for (const [id, expected] of [
    ["sea", [0, 0]],
    ["ocean-depth", [0, 0]],
    ["ocean-shallows", [0, 0]],
    ["subsurface-drift", [1, 0]],
    ["rim-surf", [0, 1]],
  ] as const) {
    weather.configure({
      ...defaultChartSettings,
      composition: { hidden: [], solo: sceneLayerSolo(id) },
    });
    expect([drift.value, surf.value]).toEqual(expected);
    expect(weather.animating?.()).toBe(expected.some(Boolean));
    expect(sceneAnimating([weather], { matches: true })).toBe(false);
  }
  weather.configure({
    ...defaultChartSettings,
    composition: { hidden: ["subsurface-drift"], solo: [] },
  });
  expect([drift.value, surf.value]).toEqual([0, 1]);
  weather.configure({
    ...defaultChartSettings,
    clouds: false,
    composition: { hidden: [], solo: sceneLayerSolo("subsurface-drift") },
  });
  expect([drift.value, surf.value]).toEqual([0, 0]);
  weather.configure(defaultChartSettings);
  expect([drift.value, surf.value]).toEqual([1, 1]);
  expect(weather.drawn).toEqual({ drift, surf });
  expect(defaultChartSettings.clouds).toBe(true);
  expect(defaultChartSettings.waves).toBe(true);
  weather.dispose();
  clock.dispose();
});

it("runs drift over land without water but stops when neither surface is visible", () => {
  const clock = createClock(0);
  let paper = true;
  const weather = createWeatherLayer(clock, () => ({ paper, sea: false }));
  weather.configure({
    ...defaultChartSettings,
    composition: { hidden: [], solo: ["relief", "subsurface-drift"] },
  });
  expect(weather.animating?.()).toBe(true);
  clock.tick(1000, weather.animating?.());
  expect(clock.time.value).toBe(1);
  paper = false;
  expect(weather.animating?.()).toBe(false);
  clock.tick(10_000, weather.animating?.());
  expect(clock.time.value).toBe(1);
  paper = true;
  clock.tick(20_000, weather.animating?.());
  expect(clock.time.value).toBe(1);
  clock.tick(21_000, weather.animating?.());
  expect(clock.time.value).toBe(2);
  weather.dispose();
  clock.dispose();
});
