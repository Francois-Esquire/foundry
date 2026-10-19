import { expect, it, vi } from "vitest";
import { createViewState } from "../../src/web/scene/view-state";
import { defaultChartSettings } from "../../src/web/settings/chart-settings";
import { createChromePresenter } from "../../src/web/ui/chart-chrome-model";
import type { TextMetrics } from "../../src/web/ui/map-labels/measure";
import type { Frame } from "../../src/web/ui/map-labels/text-element";
import { twoIslands } from "../helpers/island-fixture";

const metrics: TextMetrics = {
  baseline: () => 0.8,
  dispose: vi.fn(),
  measure: (text) => text.length * 0.55,
};
function frame(): Frame {
  return {
    pixelRatio: 1,
    pixels: 2,
    screen: (x, y) => ({ x: 550 + x, y: 380 + y }),
    state: createViewState(twoIslands, defaultChartSettings),
    view: { height: 380, pixelsPerUnit: 2, tilt: 0, width: 550, x: 0, y: 0 },
  };
}

it("caps caption typography and omits the whole pair when interactive furniture covers it", () => {
  const publish = vi.fn();
  const present = createChromePresenter(publish);
  const current = frame();
  present(current, metrics);
  expect(
    publish.mock.lastCall?.[0].notes.map(
      (note: { style: { fontSize: number } }) => note.style.fontSize
    )
  ).toEqual([18, 9]);
  const exclusions = [{ bottom: 720, left: 300, right: 800, top: 560 }];
  present({ ...current, exclusions }, metrics);
  expect(publish.mock.lastCall?.[0].notes).toEqual([]);
  expect(publish).toHaveBeenCalledTimes(2);
  present(
    { ...current, exclusions: exclusions.map((rect) => ({ ...rect })) },
    metrics
  );
  expect(publish).toHaveBeenCalledTimes(2);
  present(current, metrics);
  expect(publish.mock.lastCall?.[0].notes).toHaveLength(2);
});

it("does not leave an offscreen sea caption behind after a pan", () => {
  const publish = vi.fn();
  const present = createChromePresenter(publish);
  present(
    { ...frame(), screen: (x, y) => ({ x: x + 550, y: y + 900 }) },
    metrics
  );
  expect(publish.mock.lastCall?.[0].notes).toEqual([]);
});
