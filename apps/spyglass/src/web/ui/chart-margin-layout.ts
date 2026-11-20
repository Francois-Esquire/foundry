import { chartGrid } from "../data/bindings";
import type { SpyglassData } from "../data/types";
import { inks } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import type { LabelFont } from "../layout/labels";
import { type InkView, viewSquash } from "../view/chart-view";
import type { ScreenRect } from "./map-labels/exclusions";

export const marginNote = {
  font: { face: "SpyglassBody", letterSpacing: 0.1 } satisfies LabelFont,
  halo: 3,
  size: 10,
} as const;

export const gridReferenceStyle = {
  font: { face: "SpyglassDisplay", letterSpacing: 0.04 } satisfies LabelFont,
  size: 12,
} as const;

export interface GridReference {
  edge: "top" | "left";
  text: string;
  x: number;
  y: number;
}

function columnName(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26
    ? letter
    : `${columnName(Math.floor(index / 26) - 1)}${letter}`;
}

export function gridReferenceLimits(
  data: Pick<SpyglassData, "height" | "width">
): GridReference[] {
  const { majorStep: step } = chartGrid(1);
  const firstColumn = Math.floor(-data.width / 2 / step);
  const lastColumn = Math.ceil(data.width / 2 / step) - 1;
  const firstRow = Math.floor(-data.height / 2 / step);
  const lastRow = Math.ceil(data.height / 2 / step) - 1;
  return [
    { edge: "top", text: "A", x: (firstColumn + 0.5) * step, y: 0 },
    {
      edge: "top",
      text: columnName(lastColumn - firstColumn),
      x: (lastColumn + 0.5) * step,
      y: 0,
    },
    { edge: "left", text: "1", x: 0, y: (firstRow + 0.5) * step },
    {
      edge: "left",
      text: String(lastRow - firstRow + 1),
      x: 0,
      y: (lastRow + 0.5) * step,
    },
  ];
}

const referenceMargin = 18;

export function gridReferences(
  view: InkView,
  data: Pick<SpyglassData, "height" | "width">
): GridReference[] {
  const { pixelsPerUnit: pixels } = view;
  const { majorStep: step } = chartGrid(pixels);
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  const firstColumn = Math.floor(-data.width / 2 / step);
  const firstRow = Math.floor(-data.height / 2 / step);
  const lastColumn = Math.ceil(data.width / 2 / step) - 1;
  const lastRow = Math.ceil(data.height / 2 / step) - 1;
  const margin = referenceMargin / pixels;
  const tiltStretch = 1 / viewSquash(view);
  const verticalMargin = margin * tiltStretch;
  const cornerClearance = 34 / pixels;
  const references: GridReference[] = [];
  const columnY = top + verticalMargin;
  for (let k = Math.floor(left / step); k * step < left + view.width; k += 1) {
    const x = (k + 0.5) * step;
    if (
      k >= firstColumn &&
      k <= lastColumn &&
      Math.abs(x - view.x) < view.width / 2 - cornerClearance
    ) {
      references.push({
        edge: "top",
        text: columnName(k - firstColumn),
        x,
        y: columnY,
      });
    }
  }
  const rowX = left + margin;
  for (let k = Math.floor(top / step); k * step < top + view.height; k += 1) {
    const y = (k + 0.5) * step;
    if (
      k >= firstRow &&
      k <= lastRow &&
      y > top + cornerClearance * tiltStretch &&
      y < top + view.height - cornerClearance * tiltStretch
    ) {
      references.push({
        edge: "left",
        text: String(k - firstRow + 1),
        x: rowX,
        y,
      });
    }
  }
  return references;
}

const legendGap = 30;
const footMargin = 96;
const headMargin = 96;
const scaleMargin = 34;
const narrowView = 760;

export const latitudeScaleStyle = {
  axis: inkStyle("latitude-scale"),
  plateAlpha: 0.85,
  plateHeight: 14,
  platePad: 3,
  textGap: 6 * 1.6,
  tick: 6,
} as const;

interface LatitudeTick {
  layer: number;
  text: string;
  y: number;
}

export interface LatitudeScale {
  opacity: number;
  plated: boolean;
  ticks: LatitudeTick[];
  x: number;
}

function placedLayers(
  data: Pick<SpyglassData, "packageLayers" | "territories">
): { layer: number; y: number }[] {
  const rows = new Map<number, number>();
  for (const territory of data.territories) {
    const layer = data.packageLayers[territory.id];
    if (
      layer !== null &&
      layer !== undefined &&
      rows.has(layer) &&
      Math.abs((rows.get(layer) ?? 0) - territory.y) > 1e-6
    ) {
      return [];
    }
    if (layer !== null && layer !== undefined && !rows.has(layer)) {
      rows.set(layer, territory.y);
    }
  }
  return [...rows]
    .map(([layer, y]) => ({ layer, y }))
    .sort((a, b) => a.layer - b.layer);
}

function scaleText(layer: number): string {
  return layer === 0 ? "FOUNDATION · 0" : `LAYER ${layer}`;
}

export function latitudeScale(
  data: Pick<SpyglassData, "packageLayers" | "territories">,
  view: InkView,
  strength: number,
  legendHeight: number
): LatitudeScale | null {
  const ticks = placedLayers(data);
  if (ticks.length === 0 || strength <= 0) {
    return null;
  }
  const pixels = view.pixelsPerUnit;
  const verticalPixels =
    pixels * (view.tilt === undefined ? 1 : viewSquash(view));
  const top = view.y - view.height / 2 + headMargin / verticalPixels;
  const clearance = Math.max(footMargin, legendHeight + legendGap);
  const bottom = view.y + view.height / 2 - clearance / verticalPixels;
  const visible = ticks.filter(({ y }) => y >= top && y <= bottom);
  if (visible.length === 0) {
    return null;
  }
  return {
    opacity: strength,
    plated: view.width * pixels < narrowView,
    ticks: visible.map(({ layer, y }) => ({
      layer,
      text: scaleText(layer),
      y,
    })),
    x: view.x + view.width / 2 - scaleMargin / pixels,
  };
}

export interface WorldNote {
  font: LabelFont;
  ink: string;
  size: number;
  text: string;
  x: number;
  y: number;
}

export function seaCaption(
  data: Pick<SpyglassData, "height">
): readonly WorldNote[] {
  return [
    {
      font: { face: "Georgia", italic: true, letterSpacing: 0 },
      ink: inks.seaCaption,
      size: 14,
      text: "The dependency sea",
      x: 0,
      y: data.height / 2 - 38,
    },
  ];
}

export function marginNoteFits(
  note: ScreenRect,
  viewport: { width: number; height: number },
  exclusions: readonly ScreenRect[] = []
): boolean {
  const edge = 18;
  const clearance = 8;
  return (
    note.left >= edge &&
    note.right <= viewport.width - edge &&
    note.top >= edge &&
    note.bottom <= viewport.height - edge &&
    !exclusions.some(
      (area) =>
        note.left < area.right + clearance &&
        note.right > area.left - clearance &&
        note.top < area.bottom + clearance &&
        note.bottom > area.top - clearance
    )
  );
}
