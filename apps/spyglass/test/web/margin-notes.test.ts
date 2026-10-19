import { expect, it } from "vitest";
import { latitude } from "../../src/web/data/bindings";
import { inks } from "../../src/web/ladder/ink-ladder";
import {
  gridReferences,
  latitudeScale,
  seaCaption,
} from "../../src/web/layout/margin-notes";
import { detailLevel } from "../../src/web/view/detail-level";
import { twoIslands as data, island } from "../helpers/island-fixture";

const view = { height: 500, pixelsPerUnit: 2, width: 500, x: 0, y: 0 };

it("prints lettered columns and numbered rows from the chart corner", () => {
  const printed = gridReferences(view, data);
  const texts = printed.map((reference) => reference.text);
  expect(texts).toContain("A");
  expect(texts).toContain("C");
  expect(texts).toContain("2");
  const column = printed.find((reference) => reference.text === "C");
  expect(column?.y).toBeCloseTo(-250 + 9 / Math.cos(0.7));
  const row = printed.find((reference) => reference.text === "2");
  expect(row?.x).toBe(-241);
  // A place name covering the column margin hides its references.
  const covered = gridReferences(view, data, [
    {
      caption: "2 FILES",
      font: { face: "SpyglassDisplay", letterSpacing: 0 },
      halo: 6,
      height: 20,
      ink: inks.label,
      kind: "island",
      opacity: 1,
      place: { territory: island },
      territory: island,
      text: "Island",
      width: 400,
      x: 0,
      y: -250 + 9 / Math.cos(0.7),
      z: 0,
    },
  ]);
  expect(covered.map((reference) => reference.text)).not.toContain("C");
  // Panning never renames a cell.
  const panned = gridReferences({ ...view, x: 90 }, data);
  expect(panned.some((reference) => reference.text === "C")).toBe(true);
});

it("numbers the dependency layers on their rows, the foundation to the south", () => {
  const layered = {
    ...data,
    packageLayers: { island: 0, "one-up": 1, other: null, "two-up": 2 },
    territories: [
      ...data.territories,
      { ...island, id: "one-up", label: "One up", x: -300, y: -220 },
      { ...island, id: "two-up", label: "Two up", x: 300, y: -440 },
    ],
  };
  const scale = latitudeScale(
    layered,
    { height: 1200, pixelsPerUnit: 1, width: 900, x: 0, y: -220 },
    1,
    0
  );
  expect(scale?.ticks.map((tick) => tick.text)).toEqual([
    "FOUNDATION · 0",
    "LAYER 1",
    "LAYER 2",
  ]);
  const tickAt = (text: string) =>
    scale?.ticks.find((tick) => tick.text === text)?.y;
  expect(tickAt("LAYER 1")).toBe(latitude(1));
  expect(tickAt("LAYER 2")).toBe(latitude(2));
  expect(scale?.x).toBe(450 - 34);
  expect(scale?.plated).toBe(false);
});

it("lets the latitude scale give way at island zoom, so it never prints over an island", () => {
  const scaleAt = (pixelsPerUnit: number) =>
    latitudeScale(
      { ...data, packageLayers: { island: 0 } },
      { height: 800, pixelsPerUnit, width: 600, x: 0, y: 0 },
      detailLevel(pixelsPerUnit).scale,
      0
    );
  expect(scaleAt(1)?.ticks.map((tick) => tick.text)).toContain(
    "FOUNDATION · 0"
  );
  expect(scaleAt(1)?.opacity).toBe(1);
  expect(scaleAt(2.2)).toBeNull();
});

it("draws no latitude scale without placed layers, and stops above the legend", () => {
  const wide = { height: 1200, pixelsPerUnit: 1, width: 900, x: 0, y: -220 };
  expect(latitudeScale({ ...data, packageLayers: {} }, wide, 1, 0)).toBeNull();
  const foundation = { ...data, packageLayers: { island: 0 } };
  const low = { height: 800, pixelsPerUnit: 1, width: 600, x: 0, y: -300 };
  // The island's row sits 100 units above the foot: within the foot margin's 96, clear of a legend taller than that.
  expect(latitudeScale(foundation, low, 1, 0)?.ticks).toHaveLength(1);
  expect(latitudeScale(foundation, low, 1, 200)).toBeNull();
});

it("sets the latitude scale on a paper plate on a narrow screen, where islands reach the margin", () => {
  const plated = (width: number) =>
    latitudeScale(
      { ...data, packageLayers: { island: 0 } },
      { height: 800, pixelsPerUnit: 1, width, x: 0, y: 0 },
      1,
      0
    )?.plated;
  expect(plated(390)).toBe(true);
  expect(plated(1500)).toBe(false);
});

it("sets the sea's caption under the southern margin in map units", () => {
  const [name, caveat] = seaCaption(data);
  expect(name).toMatchObject({
    font: { face: "Georgia", italic: true },
    ink: inks.seaCaption,
    size: 14,
    x: 0,
    y: 250 - 38,
  });
  expect(caveat).toMatchObject({ size: 6, y: 250 - 22 });
});
