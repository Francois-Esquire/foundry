import { chartGrid } from "../data/bindings";
import type { SpyglassData } from "../data/types";
import { inks } from "../ladder/ink-ladder";
import { inkStyle } from "../ladder/ink-table";
import { type InkView, tiltStretch } from "../view/chart-view";
import type { LabelFont, MapLabel } from "./labels";

/**
 * The chart's margin notes, as the labels layer sets them: grid references
 * along the top and left margins, the latitude scale in the right margin,
 * the sea's caption under the southern margin. Each
 * is geometry here; the layer letters it.
 */

/** A small note set in the body face: its size in screen pixels, the space between its letters, and its halo. */
export const marginNote = {
  font: { face: "SpyglassBody", letterSpacing: 0.1 } satisfies LabelFont,
  halo: 3,
  size: 10,
} as const;

/** Screen furniture has stronger ink and full-height lettering than notes on the map. */
export const gridReferenceStyle = {
  font: { face: "SpyglassBody", letterSpacing: 0.06 } satisfies LabelFont,
  halo: 0,
  size: 12,
} as const;

/** A grid reference: its text, and the middle of its text in map units. */
export interface GridReference {
  edge: "top" | "left";
  text: string;
  x: number;
  y: number;
}

/** Column letters, then AA, AB… once a chart outgrows the alphabet. */
function columnName(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26
    ? letter
    : `${columnName(Math.floor(index / 26) - 1)}${letter}`;
}

/** The references' margins, in screen pixels: from the edge to the text's middle, and the clearance a place name takes from them. */
const referenceMargin = 18;
const referenceClearance = 14;

/**
 * Spyglass references for each major cell: lettered columns along the top
 * margin, numbered rows down the left, counted from the chart's own corner
 * so a place keeps its reference ("D4") at every zoom. References give way
 * to place names: one within a name's clearance is left out; they are
 * margin notes, not places.
 */
export function gridReferences(
  view: InkView,
  data: Pick<SpyglassData, "height" | "width">,
  labels: readonly MapLabel[] = []
): GridReference[] {
  const { pixelsPerUnit: pixels } = view;
  const { majorStep: step } = chartGrid(pixels);
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  const firstColumn = Math.floor(-data.width / 2 / step);
  const firstRow = Math.floor(-data.height / 2 / step);
  const margin = referenceMargin / pixels;
  const verticalMargin = margin * tiltStretch;
  const clearance = referenceClearance / pixels;
  const cornerClearance = 34 / pixels;
  const covered = (x: number, y: number) =>
    labels.some(
      (label) =>
        Math.abs(label.x - x) < label.width / 2 + clearance &&
        y > label.y - label.height - clearance &&
        y < label.y + clearance
    );
  const references: GridReference[] = [];
  const columnY = top + verticalMargin;
  for (let k = Math.floor(left / step); k * step < left + view.width; k += 1) {
    const x = (k + 0.5) * step;
    if (
      k >= firstColumn &&
      Math.abs(x - view.x) < view.width / 2 - cornerClearance &&
      !covered(x, columnY)
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
      y > top + cornerClearance * tiltStretch &&
      y < top + view.height - cornerClearance * tiltStretch &&
      !covered(rowX, y)
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

/** Space kept clear above the legend, and at the foot when there is none, in CSS pixels. */
const legendGap = 30;
const footMargin = 96;
/** The scale keeps this far from the head of the view, in CSS pixels. */
const headMargin = 96;
/** The axis sits this far from the right edge, in CSS pixels. */
const scaleMargin = 34;
/** Below this view width in CSS pixels, the legend's narrow breakpoint in spyglass.css, islands reach the margin, so each number sits on a plate. */
const narrowView = 760;

/** The latitude scale's measures in screen pixels: a tick's half length, the gap from the axis to a number, and a plate's padding and height. */
export const latitudeScaleStyle = {
  axis: inkStyle("latitude-scale"),
  /** The plate's paper over the map beneath. */
  plateAlpha: 0.85,
  plateHeight: 14,
  platePad: 3,
  textGap: 6 * 1.6,
  tick: 6,
} as const;

/** One dependency layer on the scale: its number, its text and its latitude in map units. */
interface LatitudeTick {
  layer: number;
  text: string;
  y: number;
}

/** The latitude scale as laid out: its axis's x in map units, its ticks, how strongly it shows, and whether each number sits on a plate. */
export interface LatitudeScale {
  opacity: number;
  plated: boolean;
  ticks: LatitudeTick[];
  x: number;
}

/**
 * The placed dependency layers, foundation first, each at its row's
 * latitude. Every island sits exactly on its layer's row, `latitude(layer)`
 * moved by the one offset that centres the spyglass, so a tick is nominal:
 * any of the layer's islands gives it. A collection's frames share that
 * axis (`sideBySide`), so one scale serves every frame: each frame's layer
 * is its own workspace's.
 */
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

/**
 * The latitude scale in the right margin: a tick at each dependency layer's
 * latitude and its number, the foundation (layer 0) to the south. Packages
 * the graph could not place are kept off the scale; their captions say so.
 * A margin note, like the grid references: it takes no part in label
 * collision, and it fades out with `strength` (`detail.scale`) as an
 * island's districts come in, so that it never prints over an island seen
 * close. None without placed layers, with none in the margin, or at no
 * strength; it stops short of the legend at the foot.
 */
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
  const top = view.y - view.height / 2 + headMargin / pixels;
  // The legend sits at the foot of the right margin; the scale stops above it.
  const clearance = Math.max(footMargin, legendHeight + legendGap);
  const bottom = view.y + view.height / 2 - clearance / pixels;
  const visible = ticks.filter(({ y }) => y >= top && y <= bottom);
  if (visible.length === 0) {
    return null;
  }
  return {
    opacity: strength,
    // On a narrow screen islands run under the margin: each number sits on a
    // paper plate of its own, so it stays clear of them and they stay seen.
    plated: view.width * pixels < narrowView,
    ticks: visible.map(({ layer, y }) => ({
      layer,
      text: scaleText(layer),
      y,
    })),
    x: view.x + view.width / 2 - scaleMargin / pixels,
  };
}

/** A line of text set in map units, so it scales with the zoom: its size is in units, not pixels. */
export interface WorldNote {
  font: LabelFont;
  ink: string;
  size: number;
  text: string;
  x: number;
  y: number;
}

/** The sea's name and the chart's one caveat, set under the southern margin. */
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
    {
      font: { face: "SpyglassBody", letterSpacing: 0 },
      ink: inks.seaCaption,
      size: 6,
      text: "DISTANCE EXPRESSES RELATIONSHIP · NOT PHYSICAL SCALE",
      x: 0,
      y: data.height / 2 - 22,
    },
  ];
}
