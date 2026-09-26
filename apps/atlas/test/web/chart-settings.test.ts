import { expect, it } from "vitest";

import { defaultChartSettings } from "../../src/web/chart-settings";
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
