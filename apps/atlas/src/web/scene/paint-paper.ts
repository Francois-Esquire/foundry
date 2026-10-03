import { chartGrid } from "../codex/bindings";
import { unit } from "../geography";
import type { AtlasData, Territory } from "../types";
import type { InkView, MapLabel } from "./exploration";

/** Gold leaf, yellower and paler than the amber reserved for focus. */
const gilt = "#c9a443";

/** One graticule ink on sea and land, so the grid reads as a single printing. */
export const gridInk = "#6c6852";

/** Coordinates stay fixed while minor divisions become legible with zoom. */
export function paintChartGrid(
  ctx: CanvasRenderingContext2D,
  view: InkView,
  data: AtlasData
) {
  const { pixelsPerUnit: pixels } = view;
  const { majorStep, minorOpacity, minorStep } = chartGrid(pixels);
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  const right = left + view.width;
  const bottom = top + view.height;
  ctx.save();
  // Sea ink stops at land; the same coordinates are printed on the relief mesh.
  ctx.beginPath();
  ctx.rect(left, top, view.width, view.height);
  traceLand(ctx, data);
  ctx.clip("evenodd");
  for (const { step, opacity, width } of [
    { opacity: minorOpacity, step: minorStep, width: 0.5 },
    { opacity: 0.3, step: majorStep, width: 0.7 },
  ]) {
    if (!opacity) {
      continue;
    }
    ctx.beginPath();
    ctx.strokeStyle = gridInk;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = width / pixels;
    for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Column letters, then AA, AB… once a chart outgrows the alphabet. */
function columnName(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26
    ? letter
    : `${columnName(Math.floor(index / 26) - 1)}${letter}`;
}

/**
 * Atlas references for each major cell: lettered columns along the top margin,
 * numbered rows down the left, counted from the chart's own corner so a place
 * keeps its reference ("D4") at every zoom.
 */
export function paintGridReferences(
  ctx: CanvasRenderingContext2D,
  view: InkView,
  data: AtlasData,
  labels: readonly MapLabel[] = []
) {
  const { pixelsPerUnit: pixels } = view;
  const { majorStep: step } = chartGrid(pixels);
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  const firstColumn = Math.floor(-data.width / 2 / step);
  const firstRow = Math.floor(-data.height / 2 / step);
  const margin = 18 / pixels;
  ctx.save();
  ctx.font = `${10 / pixels}px AtlasBody`;
  ctx.letterSpacing = `${1 / pixels}px`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3 / pixels;
  ctx.strokeStyle = "#e3e6d4";
  ctx.fillStyle = gridInk;
  const clearance = 14 / pixels;
  // References give way to place names; they are margin notes, not places.
  const print = (text: string, x: number, y: number) => {
    const covered = labels.some(
      (label) =>
        Math.abs(label.x - x) < label.width / 2 + clearance &&
        y > label.y - label.height - clearance &&
        y < label.y + clearance
    );
    if (!covered) {
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  };
  const columnY = top + 76 / pixels;
  for (let k = Math.floor(left / step); k * step < left + view.width; k += 1) {
    const x = (k + 0.5) * step;
    if (k >= firstColumn && Math.abs(x - view.x) < view.width / 2 - margin) {
      print(columnName(k - firstColumn), x, columnY);
    }
  }
  const rowX = left + margin;
  for (let k = Math.floor(top / step); k * step < top + view.height; k += 1) {
    const y = (k + 0.5) * step;
    if (
      k >= firstRow &&
      y > columnY + margin &&
      y < top + view.height - 80 / pixels
    ) {
      print(String(k - firstRow + 1), rowX, y);
    }
  }
  ctx.restore();
}

export const penWeights = [0.7, 0.9, 1.1, 1.35];
const penKnot = 7;
const pens = new WeakMap<Territory, number[][][]>();

/**
 * Pen pressure along one ring, seeded by `seed` and arc length so it is
 * identical on every repaint. Runs are appended to one bucket per weight; where
 * pressure falls below `lift` the pen leaves the paper and the line breaks.
 */
export function penRuns(
  ring: readonly (readonly [number, number])[],
  seed: string,
  buckets: number[][][],
  lift = 0
) {
  const knot = (k: number) => unit(`${seed}:${k}`);
  let travelled = 0;
  let current: number[] | undefined;
  let bucket = -1;
  for (let i = 1; i < ring.length; i += 1) {
    const a = ring[i - 1];
    const b = ring[i];
    if (!(a && b)) {
      continue;
    }
    const k = Math.floor(travelled / penKnot);
    const t = travelled / penKnot - k;
    const pressure = knot(k) + (knot(k + 1) - knot(k)) * t * t * (3 - 2 * t);
    travelled += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (pressure < lift) {
      current = undefined;
      bucket = -1;
      continue;
    }
    const next = Math.min(
      penWeights.length - 1,
      Math.floor(((pressure - lift) / (1 - lift)) * penWeights.length)
    );
    if (next !== bucket || !current) {
      current = [a[0], a[1]];
      buckets[next]?.push(current);
      bucket = next;
    }
    current.push(b[0], b[1]);
  }
}

/** The coast's pen runs, grouped by weight so each weight is one stroke. */
function coastPen(territory: Territory) {
  let runs = pens.get(territory);
  if (!runs) {
    const buckets: number[][][] = penWeights.map(() => []);
    for (const [p, polygon] of territory.coast.entries()) {
      for (const [r, ring] of polygon.entries()) {
        penRuns(ring, `${territory.id}:coast:${p}:${r}`, buckets);
      }
    }
    runs = buckets;
    pens.set(territory, runs);
  }
  return runs;
}

/** Gilt and coast ink are repainted at viewport resolution, never magnified texels. */
export function paintCoastInk(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  pixels: number,
  selected: boolean
) {
  ctx.save();
  ctx.translate(territory.x, territory.y);
  ctx.beginPath();
  traceCoast(ctx, territory);
  ctx.lineJoin = "round";
  // All coast ink stays inside the shore: it drapes on the raised land, so no
  // half-stroke is left on the sea plane to ghost across a far-side coast.
  ctx.clip("evenodd");
  // A gilt rule framed by a fine inner hairline; occlusion never dims it.
  // Selection is shown by the gilt surround in selection-ink.ts.
  ctx.strokeStyle = "#5a4a2e8c";
  ctx.lineWidth = 6.5 / pixels;
  ctx.stroke();
  ctx.strokeStyle = gilt;
  ctx.lineWidth = 5.5 / pixels;
  ctx.stroke();
  // Hand-inked coastline: the pen swells and thins along the shore. Widths are
  // doubled because only the inner half survives the clip.
  ctx.lineCap = "round";
  ctx.strokeStyle = "#4c4031d9";
  strokePen(ctx, territory, (selected ? 2.6 : 2) / pixels);
  ctx.restore();
}

function strokePen(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  base: number
) {
  strokeRuns(ctx, coastPen(territory), base);
}

/** One stroke per pen weight; `base` is the line width at unit pressure. */
export function strokeRuns(
  ctx: CanvasRenderingContext2D,
  buckets: number[][][],
  base: number
) {
  for (const [index, runs] of buckets.entries()) {
    ctx.beginPath();
    for (const run of runs) {
      ctx.moveTo(run[0] ?? 0, run[1] ?? 0);
      for (let i = 2; i < run.length; i += 2) {
        ctx.lineTo(run[i] ?? 0, run[i + 1] ?? 0);
      }
    }
    ctx.lineWidth = base * (penWeights[index] ?? 1);
    ctx.stroke();
  }
}

function traceCoast(
  ctx: CanvasRenderingContext2D,
  territory: Territory,
  dx = 0,
  dy = 0
) {
  for (const polygon of territory.coast) {
    for (const ring of polygon) {
      for (const [index, [x, y]] of ring.entries()) {
        if (index) {
          ctx.lineTo(x + dx, y + dy);
        } else {
          ctx.moveTo(x + dx, y + dy);
        }
      }
      ctx.closePath();
    }
  }
}

export function traceLand(ctx: CanvasRenderingContext2D, data: AtlasData) {
  for (const territory of data.territories) {
    traceCoast(ctx, territory, territory.x, territory.y);
  }
}
