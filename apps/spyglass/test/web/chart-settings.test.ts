import { expect, it } from "vitest";

import {
  cameraAngleAt,
  cameraAngles,
  defaultChartSettings,
  defaultDeveloperSettings,
  defaultReaderSettings,
} from "../../src/web/settings/chart-settings";

it("splits the chart's settings into a reader's and a developer's", () => {
  const reader = Object.keys(defaultReaderSettings);
  const developer = Object.keys(defaultDeveloperSettings);
  expect(reader.filter((key) => developer.includes(key))).toEqual([]);
  expect([...reader, ...developer].sort()).toEqual(
    Object.keys(defaultChartSettings).sort()
  );
  // The waves, which carry no data, start on; the camera starts at the
  // chart's own angle.
  expect(defaultReaderSettings.waves).toBe(true);
  expect(defaultReaderSettings.camera.elevation).toBe(
    cameraAngles.chart.elevation
  );
  expect(Object.keys(defaultDeveloperSettings)).toEqual(["composition"]);
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
