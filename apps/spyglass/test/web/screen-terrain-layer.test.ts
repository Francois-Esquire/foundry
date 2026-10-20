import { expect, it } from "vitest";
import { numberMath } from "../../src/lib/visualization/terrain-kernel";
import { kernelPlate } from "../../src/lib/visualization/terrain-kernel-plate";
import {
  defaultGeologyPreviewSettings,
  plateShade,
} from "../../src/web/scene/geology-layer";
import { sunDirection } from "../../src/web/scene/geology-light";
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

it("lights a plate as the geology preview's plateShade does", () => {
  const run = Math.hypot(sunDirection.x, sunDirection.y);
  const sun = [sunDirection.x / run, sunDirection.y / run] as const;
  const settings = defaultGeologyPreviewSettings.terraces;
  for (let step = 0; step < 400; step += 1) {
    const coordinate = 3 + step * 0.0137;
    const footprint = [0, 1e-7, 0.01, 0.05, 0.3, 2][step % 6] ?? 0;
    const depth = [2, 8, 30, 150, 400, 900][step % 5] ?? 0;
    const angle = step * 0.7;
    const tilt = [0, 0.005, 0.02, 0.2][step % 4] ?? 0;
    const normal = [Math.cos(angle) * tilt, Math.sin(angle) * tilt, 1] as const;
    const kernel = kernelPlate(
      numberMath,
      { coordinate, depth, footprint, normal },
      sun,
      settings
    );
    expect(kernel).toBeCloseTo(
      plateShade({ coordinate, depth, footprint, normal, settings }),
      9
    );
  }
});
