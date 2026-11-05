import assert from "node:assert/strict";
import { expect, it } from "vitest";
import type { SpyglassData } from "../../src/web/data/types";
import { inks } from "../../src/web/ladder/ink-ladder";
import {
  labelCandidates,
  placeLabels,
  visibleLabels,
} from "../../src/web/layout/label-candidates";
import {
  flatMarkHeight,
  labelWorldPoint,
  type MapLabel,
  type TextMeasure,
} from "../../src/web/layout/labels";
import type { InkView } from "../../src/web/view/chart-view";
import { detailLevel } from "../../src/web/view/detail-level";
import { twoIslands as data } from "../helpers/island-fixture";
import { flatScreen, perspectiveCamera } from "../helpers/label-screen";

/** A fake measure: every character is 0.55 em wide, whatever the font. */
const measure: TextMeasure = (text) => text.length * 0.55;

/** The labels proposed and placed for a frame, as the labels layer does it. */
function labelsFor(options: {
  data: SpyglassData;
  fileId?: string | null;
  selected?: string | null;
  view: InkView;
}): MapLabel[] {
  const fileId = options.fileId ?? null;
  const candidates = labelCandidates(
    {
      data: options.data,
      detail: detailLevel(options.view.pixelsPerUnit),
      fileId,
      selected: options.selected ?? null,
      view: options.view,
    },
    measure
  );
  return placeLabels(candidates, flatScreen(options.view), fileId);
}

const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };

it("captions each package name with its real file count, and marks an unplaced island", () => {
  const labels = labelsFor({
    data: { ...data, packageLayers: { island: 0, other: null } },
    view: { ...view, pixelsPerUnit: 1, width: 700 },
  });
  const caption = (text: string) =>
    labels
      .filter((label) => label.kind === "island")
      .find((label) => label.text === text)?.caption;
  expect(caption("Island")).toBe("2 FILES");
  expect(caption("Other")).toBe("0 FILES · NO LAYER");
});

it("sets each label in the ladder's inks and halos, measured in its font", () => {
  const close = { ...view, pixelsPerUnit: 5 };
  const labels = labelsFor({
    data,
    fileId: "one",
    selected: "island",
    view: close,
  });
  const selected = labels.find((label) => label.place?.file?.id === "one");
  const name = labels.find((label) => label.kind === "island");
  // Other files are named while no file is focused in view.
  const file = labelsFor({ data, selected: "island", view: close }).find(
    (label) => label.place?.file?.id === "two"
  );
  assert(selected && name && file);
  expect(selected).toMatchObject({
    font: { face: "SpyglassBody" },
    halo: 6,
    height: 20 / 5,
    ink: inks.selection,
    kind: "file",
  });
  expect(selected.width).toBeCloseTo("one.ts".length * 0.55 * (20 / 5));
  expect(name).toMatchObject({
    font: { face: "SpyglassDisplay" },
    halo: 6,
    ink: inks.label,
  });
  expect(file).toMatchObject({ halo: 3, ink: inks.label, kind: "file" });
  // The gilt and amber the ladder replaced are gone from the labels.
  for (const label of labels) {
    expect(["#b38a32", "#875222"]).not.toContain(label.ink);
  }
});

it.each([undefined, 0, (55 * Math.PI) / 180])(
  "sets every anchor on the paper, where the map raises it onto the land, for tilt %s",
  (tilt) => {
    const labels = labelsFor({
      data,
      selected: "island",
      view: { ...view, pixelsPerUnit: 5, tilt },
    });
    const file = labels.find((label) => label.place?.file?.id === "one");
    assert(file?.place?.file);
    expect(file.y).toBeCloseTo(file.place.file.y - 7 / 5);
    for (const label of labels) {
      expect(label.z).toBe(flatMarkHeight);
      expect(labelWorldPoint(label, tilt)).toEqual({
        x: label.x,
        y: label.y,
        z: flatMarkHeight,
      });
    }
  }
);

it("reserves UI rectangles on screen before label placement, including the caption below an island name", () => {
  const labels = labelsFor({ data, view });
  const name = labels.find((label) => label.kind === "island");
  assert(name);
  const screen = flatScreen(view);
  const at = screen.at(name);
  const tall = name.height * view.pixelsPerUnit;
  const titleBlocker = {
    bottom: at.y,
    left: at.x - 4,
    right: at.x + 4,
    top: at.y - tall / 2,
  };
  expect(placeLabels(labels, screen, null, [titleBlocker])).not.toContain(name);
  const captionBlocker = {
    ...titleBlocker,
    bottom: at.y + 6,
    top: at.y + 2,
  };
  expect(visibleLabels(labels, screen, [captionBlocker])).not.toContain(name);
  expect(
    visibleLabels(labels, screen, [
      { bottom: 10_001, left: 10_000, right: 10_001, top: 10_000 },
    ])
  ).toContain(name);
});

it("keeps what a perspective camera shows on screen, not what a flat rectangle of the chart would", () => {
  const camera = perspectiveCamera({
    distance: 100,
    fieldOfView: Math.PI / 4,
    height: 400,
    pitch: 1.05,
    width: 600,
  });
  // The view the chrome reads: exact at the centre only.
  const tilt = Math.PI / 2 - 1.05;
  const flatHeight = 400 / (camera.pixelsPerUnit * Math.cos(tilt));
  const [label] = labelsFor({ data, view });
  assert(label);
  const named = (text: string, y: number): MapLabel => ({
    ...label,
    height: 2,
    text,
    width: 10,
    x: 0,
    y,
  });
  // Beyond the flat rectangle's far (north) edge, but on the canvas, near
  // its top: the far side is shown smaller, so the canvas reaches further.
  const far = named("far", -0.55 * flatHeight);
  // Inside the flat rectangle's near (south) edge, but below the canvas:
  // the near side is shown larger.
  const near = named("near", 0.45 * flatHeight);
  expect(Math.abs(far.y)).toBeGreaterThan(flatHeight / 2);
  expect(camera.project(0, far.y).y).toBeGreaterThan(0);
  expect(camera.project(0, far.y).y).toBeLessThan(100);
  expect(near.y).toBeLessThan(flatHeight / 2);
  expect(camera.project(0, near.y).y).toBeGreaterThan(400);
  expect(visibleLabels([far, near], camera.screen)).toEqual([far]);
});
