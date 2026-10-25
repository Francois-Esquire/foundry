import { expect, it } from "vitest";

import {
  cameraAngleAt,
  cameraAngles,
  defaultChartSettings,
  defaultDeveloperSettings,
  defaultReaderSettings,
} from "../../src/web/settings/chart-settings";
import { defaultLandmassSettings } from "../../src/web/settings/landmass-settings";

it("opens as islands with optional layers off without changing placement defaults", () => {
  expect(
    Object.values(defaultChartSettings.layers).every((value) => !value)
  ).toBe(true);
  expect(
    Object.values(defaultChartSettings.boundaries).every((value) => !value)
  ).toBe(true);
  expect(defaultChartSettings.contours).toBe(false);
  expect(defaultChartSettings.coastalBuffer).toBe(
    defaultLandmassSettings.coastalBuffer
  );
  expect(defaultChartSettings.islandClearance).toBe(
    defaultLandmassSettings.islandClearance
  );
});

it("splits the chart's settings into a reader's layers and a developer's controls", () => {
  const reader = Object.keys(defaultReaderSettings);
  const developer = Object.keys(defaultDeveloperSettings);
  expect(reader.filter((key) => developer.includes(key))).toEqual([]);
  expect([...reader, ...developer].sort()).toEqual(
    Object.keys(defaultChartSettings).sort()
  );
  // A reader's layers are on or off: the data layers start off, and the
  // weather, which carries no data, starts on. The camera starts at the
  // chart's own angle.
  const { camera, clouds, waves, ...dataLayers } = defaultReaderSettings;
  expect([clouds, waves]).toEqual([true, true]);
  expect(camera.elevation).toBe(cameraAngles.chart.elevation);
  expect(Object.values(dataLayers)).toEqual(
    Object.keys(dataLayers).map(() => false)
  );
  expect(Object.keys(defaultDeveloperSettings.layers).sort()).toEqual([
    "land",
    "roads",
  ]);
});

it("names the camera angles by elevation, to the whole degree", () => {
  expect(cameraAngles["top-down"].elevation).toBe(90);
  expect(cameraAngles.isometric.elevation).toBe(55);
  expect(Math.round(cameraAngles.chart.elevation)).toBe(50);
  expect(cameraAngleAt(cameraAngles.chart.elevation)).toBe("chart");
  expect(cameraAngleAt(50)).toBe("chart");
  expect(cameraAngleAt(90)).toBe("top-down");
  expect(cameraAngleAt(55.2)).toBe("isometric");
  expect(cameraAngleAt(70)).toBeUndefined();
});
