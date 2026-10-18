import { chartGrid } from "../data/bindings";
import type { SpyglassData, Territory } from "../data/types";
import { inks } from "../ladder/ink-ladder";
import type { MapLabel } from "../layout/labels";
import { type InkView, tiltStretch } from "../view/chart-view";

/** Column letters, then AA, AB… once a chart outgrows the alphabet. */
function columnName(index: number): string {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26
    ? letter
    : `${columnName(Math.floor(index / 26) - 1)}${letter}`;
}

/**
 * Spyglass references for each major cell: lettered columns along the top margin,
 * numbered rows down the left, counted from the chart's own corner so a place
 * keeps its reference ("D4") at every zoom.
 */
export function paintGridReferences(
  ctx: CanvasRenderingContext2D,
  view: InkView,
  data: SpyglassData,
  labels: readonly MapLabel[] = []
) {
  const { pixelsPerUnit: pixels } = view;
  const { majorStep: step } = chartGrid(pixels);
  const left = view.x - view.width / 2;
  const top = view.y - view.height / 2;
  const firstColumn = Math.floor(-data.width / 2 / step);
  const firstRow = Math.floor(-data.height / 2 / step);
  const margin = 18 / pixels;
  const verticalMargin = margin * tiltStretch;
  ctx.save();
  ctx.font = `${10 / pixels}px SpyglassBody`;
  ctx.letterSpacing = `${1 / pixels}px`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3 / pixels;
  ctx.strokeStyle = inks.gridReferenceHalo;
  ctx.fillStyle = inks.grid;
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
  const columnY = top + verticalMargin;
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
      y > columnY + verticalMargin &&
      y < top + view.height - verticalMargin
    ) {
      print(String(k - firstRow + 1), rowX, y);
    }
  }
  ctx.restore();
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

export function traceLand(ctx: CanvasRenderingContext2D, data: SpyglassData) {
  for (const territory of data.territories) {
    traceCoast(ctx, territory, territory.x, territory.y);
  }
}
