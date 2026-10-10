import { expect, it } from "vitest";

import {
  defaultChartSettings,
  defaultDeveloperSettings,
  defaultReaderSettings,
} from "../../src/web/chart-settings";
import { defaultLandmassSettings } from "../../src/web/landmasses";

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
  // A reader's settings are layers: each is on or off, and all start off.
  expect(Object.values(defaultReaderSettings)).toEqual(reader.map(() => false));
  expect(Object.keys(defaultDeveloperSettings.layers).sort()).toEqual([
    "land",
    "roads",
  ]);
});
