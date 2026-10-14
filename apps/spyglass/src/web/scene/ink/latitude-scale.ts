import { inkStyle, inks } from "../ink-ladder";
import type { InkState } from "./state";

/** Space kept clear above the legend, and at the foot when there is none, in CSS pixels. */
const legendGap = 30;
const footMargin = 96;
/** Below this view width in CSS pixels, the legend's narrow breakpoint in spyglass.css, islands reach the margin, so each number sits on a plate. */
const narrowView = 760;
/** The plate's paper over the map beneath. */
const plateAlpha = 0.85;

/**
 * The placed dependency layers, foundation first, each at its row's
 * latitude. Every island sits exactly on its layer's row, `latitude(layer)`
 * moved by the one offset that centres the spyglass, so a tick is nominal: any
 * of the layer's islands gives it. A collection's frames share that axis
 * (`sideBySide`), so one scale serves every frame: each frame's layer is its
 * own workspace's.
 */
function placedLayers(
  state: Pick<InkState, "data">
): { layer: number; y: number }[] {
  const rows = new Map<number, number>();
  for (const territory of state.data.territories) {
    const layer = state.data.packageLayers[territory.id];
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
 * collision, and it fades out as an island's districts come in, so that it
 * never prints over an island seen close.
 */
export function paintLatitudeScale(state: InkState): void {
  const { detail, labelContext: ctx, legendHeight, view } = state;
  const ticks = placedLayers(state);
  if (!view || ticks.length === 0 || detail.scale === 0) {
    return;
  }
  const pixels = view.pixelsPerUnit;
  const top = view.y - view.height / 2 + 96 / pixels;
  // The legend sits at the foot of the right margin; the scale stops above it.
  const clearance = Math.max(footMargin, legendHeight + legendGap);
  const bottom = view.y + view.height / 2 - clearance / pixels;
  const visible = ticks.filter(({ y }) => y >= top && y <= bottom);
  if (visible.length === 0) {
    return;
  }
  const x = view.x + view.width / 2 - 34 / pixels;
  const tick = 6 / pixels;
  const style = inkStyle("latitude-scale");
  const ys = visible.map(({ y }) => y);
  ctx.save();
  ctx.globalAlpha *= detail.scale;
  ctx.font = `${10 / pixels}px SpyglassBody`;
  ctx.letterSpacing = `${1 / pixels}px`;
  // On a narrow screen islands run under the margin: each number sits on a
  // paper plate of its own, so it stays clear of them and they stay seen.
  const plated = view.width * pixels < narrowView;
  ctx.strokeStyle = style.hue;
  ctx.lineWidth = style.weight / pixels;
  ctx.beginPath();
  ctx.moveTo(x, Math.min(...ys));
  ctx.lineTo(x, Math.max(...ys));
  ctx.stroke();
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const { layer, y } of visible) {
    ctx.strokeStyle = style.hue;
    ctx.lineWidth = style.weight / pixels;
    ctx.beginPath();
    ctx.moveTo(x - tick, y);
    ctx.lineTo(x + tick, y);
    ctx.stroke();
    const text = scaleText(layer);
    if (plated) {
      const { width } = ctx.measureText(text);
      const pad = 3 / pixels;
      ctx.save();
      ctx.globalAlpha *= plateAlpha;
      ctx.fillStyle = inks.labelHalo;
      ctx.fillRect(
        x - tick * 1.6 - width - pad,
        y - 7 / pixels,
        width + pad * 2,
        14 / pixels
      );
      ctx.restore();
    }
    ctx.lineWidth = 3 / pixels;
    ctx.strokeStyle = inks.labelHalo;
    ctx.strokeText(text, x - tick * 1.6, y);
    ctx.fillStyle = inks.scale;
    ctx.fillText(text, x - tick * 1.6, y);
  }
  ctx.restore();
}
