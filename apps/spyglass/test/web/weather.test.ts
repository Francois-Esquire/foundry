import { positionWorld } from "three/tsl";
import { expect, it } from "vitest";
import { sceneTime } from "../../src/web/scene/clock";
import {
  cloudLight,
  configureWeather,
  createWeatherLayer,
  rimSurf,
  surfBand,
  weatherDrawn,
} from "../../src/web/scene/weather";
import { defaultReaderSettings } from "../../src/web/settings/chart-settings";

it("sets the two uniforms from the reader's settings, 1 or 0", () => {
  configureWeather(defaultReaderSettings);
  expect(weatherDrawn.waves.value).toBe(1);
  expect(weatherDrawn.clouds.value).toBe(1);
  configureWeather({ clouds: false, waves: true });
  expect(weatherDrawn.waves.value).toBe(1);
  expect(weatherDrawn.clouds.value).toBe(0);
  configureWeather({ clouds: false, waves: false });
  expect(weatherDrawn.waves.value).toBe(0);
  expect(weatherDrawn.clouds.value).toBe(0);
});

it("animates while either decoration is on, and rests when both are off", () => {
  const weather = createWeatherLayer();
  expect(weather.id).toBe("weather");
  expect(weather.group).toBeUndefined();
  weather.configure({ clouds: true, waves: true });
  expect(weather.animating?.()).toBe(true);
  weather.configure({ clouds: false, waves: true });
  expect(weather.animating?.()).toBe(true);
  weather.configure({ clouds: true, waves: false });
  expect(weather.animating?.()).toBe(true);
  weather.configure({ clouds: false, waves: false });
  expect(weather.animating?.()).toBe(false);
  weather.dispose();
});

it("builds the surf and the clouds' light as nodes over the clock", () => {
  const surf = rimSurf(sceneTime, positionWorld.xy);
  const light = cloudLight(positionWorld.xy);
  expect(surf.isNode).toBe(true);
  expect(light.isNode).toBe(true);
  // The band lies just outside the rim: it peaks before it is gone.
  expect(surfBand.crest).toBeGreaterThan(0);
  expect(surfBand.reach).toBeGreaterThan(surfBand.crest);
});
