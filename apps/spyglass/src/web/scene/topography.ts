import { inkAlpha, inks } from "../ladder/ink-ladder";
import type { MapLabel } from "../layout/labels";
import type { ContourLine } from "../layout/topography";
import type { InkView } from "../view/chart-view";

export function paintTopography(
  ctx: CanvasRenderingContext2D,
  lines: ContourLine[],
  view: InkView,
  labels: MapLabel[]
): void {
  const pixels = view.pixelsPerUnit;
  const opacity = ctx.globalAlpha;
  const occupied = new Map<string, number>();
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    view.x - view.width / 2,
    view.y - view.height / 2,
    view.width,
    view.height
  );
  for (const label of labels) {
    ctx.rect(
      label.x - label.width / 2 - 4 / pixels,
      label.y - label.height - 4 / pixels,
      label.width + 8 / pixels,
      label.height + 8 / pixels
    );
  }
  ctx.clip("evenodd");
  ctx.setLineDash([]);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  paintTopographyEntries(lines, pixels, ctx, opacity, occupied, view, labels);
  ctx.restore();
}

/** Contour ink sits on the ladder: land contours on the relief rung, sea rings on the sea rung. */
function contourAlpha(line: ContourLine): number {
  if (line.sea) {
    return line.major ? inkAlpha.seaContourMajor : inkAlpha.seaContourMinor;
  }
  return line.major ? inkAlpha.landContourMajor : inkAlpha.landContourMinor;
}

function paintTopographyEntries(
  lines: ContourLine[],
  pixels: number,
  ctx: CanvasRenderingContext2D,
  opacity: number,
  occupied: Map<string, number>,
  view: InkView,
  labels: MapLabel[]
) {
  for (const [id, line] of lines.entries()) {
    const detail = line.major
      ? 1
      : Math.max(0, Math.min(1, (pixels - 1.1) / 1.2));
    if (!detail) {
      continue;
    }
    ctx.strokeStyle = line.sea ? inks.seaContour : inks.landContour;
    ctx.globalAlpha = opacity * detail * line.opacity * contourAlpha(line);
    ctx.lineWidth = (line.major ? 0.7 : 0.45) / pixels;
    ctx.beginPath();
    let drawing = false;
    drawing = paintTopographyEntriesEntries(
      line,
      pixels,
      occupied,
      view,
      id,
      labels,
      drawing,
      ctx
    );
    ctx.stroke();
  }
}

function paintTopographyEntriesEntries(
  line: ContourLine,
  pixels: number,
  occupied: Map<string, number>,
  view: InkView,
  id: number,
  labels: MapLabel[],
  initialDrawing: boolean,
  ctx: CanvasRenderingContext2D
): boolean {
  let drawing = initialDrawing;
  for (const [x, terrainY] of line.points) {
    const y = terrainY;
    const key = `${Math.floor((x * pixels) / 3)}:${Math.floor((y * pixels) / 3)}`;
    const owner = occupied.get(key);
    const hidden =
      Math.abs(x - view.x) > view.width / 2 ||
      Math.abs(y - view.y) > view.height / 2 ||
      (owner !== undefined && owner !== id) ||
      labels.some(
        (l) =>
          Math.abs(x - l.x) < l.width / 2 + 4 / pixels &&
          y > l.y - l.height - 4 / pixels &&
          y < l.y + 4 / pixels
      );
    if (hidden) {
      drawing = false;
      continue;
    }
    occupied.set(key, id);
    if (drawing) {
      ctx.lineTo(x, y);
    } else {
      ctx.moveTo(x, y);
    }
    drawing = true;
  }
  return drawing;
}
