import { float, positionWorld } from "three/tsl";
import { expect, it } from "vitest";
import { createClock } from "../../src/web/scene/clock";
import { createWeatherLayer, surfBand } from "../../src/web/scene/weather";
import { defaultReaderSettings } from "../../src/web/settings/chart-settings";

it("sets the two uniforms from the reader's settings, 1 or 0", () => {
  const clock = createClock();
  const weather = createWeatherLayer(clock);
  weather.configure(defaultReaderSettings);
  expect(weather.drawn.waves.value).toBe(1);
  expect(weather.drawn.clouds.value).toBe(1);
  weather.configure({ clouds: false, waves: true });
  expect(weather.drawn.waves.value).toBe(1);
  expect(weather.drawn.clouds.value).toBe(0);
  weather.configure({ clouds: false, waves: false });
  expect(weather.drawn.waves.value).toBe(0);
  expect(weather.drawn.clouds.value).toBe(0);
  weather.dispose();
  clock.dispose();
});

it("animates while either decoration is on, and rests when both are off", () => {
  const weather = createWeatherLayer(createClock());
  expect(weather.id).toBe("weather");
  // Declared by the layer, for its node in the composition.
  expect(weather.kind).toBe("layer");
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
  const weather = createWeatherLayer(createClock());
  const surf = weather.rimSurf(float(3), positionWorld.xy);
  const light = weather.cloudLight(positionWorld.xy);
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
  one.configure({ clouds: false, waves: false });
  expect(one.animating?.()).toBe(false);
  expect(other.animating?.()).toBe(true);
  expect(other.drawn.clouds.value).toBe(1);
  expect(other.drawn.waves.value).toBe(1);
  expect(one.drawn.clouds).not.toBe(other.drawn.clouds);
  const released: string[] = [];
  for (const [name, node] of Object.entries(one.drawn)) {
    node.addEventListener("dispose", () => {
      released.push(name);
    });
  }
  one.dispose();
  expect(released.toSorted()).toEqual(["clouds", "waves"]);
  other.dispose();
});
