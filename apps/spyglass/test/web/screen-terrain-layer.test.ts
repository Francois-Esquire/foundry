import { expect, it } from "vitest";
import {
  defaultSceneComposition,
  detailToggles,
  isSceneLayerVisible,
  sceneCompositionPresets,
} from "../../src/web/settings/scene-composition";

it("hides the screen terrain by default, outside the app bar and every preset", () => {
  expect(isSceneLayerVisible(defaultSceneComposition, "screen-terrain")).toBe(
    false
  );
  expect(
    detailToggles.flatMap(({ layers }) => layers as readonly string[])
  ).not.toContain("screen-terrain");
  for (const preset of sceneCompositionPresets) {
    expect(preset.layers).not.toContain("screen-terrain");
  }
});
