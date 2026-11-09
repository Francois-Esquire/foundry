import { expect, it } from "vitest";
import {
  defaultValues,
  layoutProblems,
} from "../../src/web/islands/lab/params";
import {
  cameraAngleAt,
  cameraAngles,
  defaultChartSettings,
  readerLayout,
  readerParams,
} from "../../src/web/settings/chart-settings";
import {
  defaultSceneComposition,
  detailToggles,
  sceneLayerParams,
  sceneLayout,
} from "../../src/web/settings/scene-composition";

it("splits the chart's settings into a reader's and a developer's", () => {
  const reader = Object.keys(readerParams);
  expect(reader).not.toContain("composition");
  expect([...reader, "composition"].sort()).toEqual(
    Object.keys(defaultChartSettings).sort()
  );
  // The waves, which carry no data, start on; the camera starts at the
  // chart's own angle. The waves keep their key.
  expect(defaultChartSettings.waves).toBe(true);
  expect(defaultChartSettings.elevation).toBe(cameraAngles.chart.elevation);
  expect(defaultChartSettings.composition).toEqual(
    defaultValues(sceneLayerParams)
  );
});

it("lays every setting out once, in a titled section", () => {
  expect(layoutProblems(readerParams, readerLayout)).toEqual([]);
  expect(layoutProblems(sceneLayerParams, sceneLayout)).toEqual([]);
});

it("starts with every detail toggle's layers hidden, and the chart frame shown", () => {
  for (const { layers } of detailToggles) {
    for (const layer of layers) {
      expect(defaultSceneComposition[layer]).toBe(false);
    }
  }
  expect(defaultSceneComposition["chart-frame"]).toBe(true);
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
