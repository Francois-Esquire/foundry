import { inkStyle, inks } from "../ink-ladder";
import type { InkState } from "./state";

/** Space kept clear above the legend, and at the foot when there is none, in CSS pixels. */
const legendGap = 30;
const footMargin = 96;

/**
 * Where each placed dependency layer sits on the map: the mean latitude of
 * its islands as they settled, foundation first. Islands drift from their
 * layer's nominal latitude as dependencies pull them together, so the scale
 * marks where a layer's islands are, not where they started.
 */
function layerLatitudes(
  state: Pick<InkState, "data">
): { layer: number; y: number }[] {
  const byLayer = new Map<number, number[]>();
  for (const territory of state.data.territories) {
    const layer = state.data.packageLayers[territory.id];
    if (layer === null || layer === undefined) {
      continue;
    }
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), territory.y]);
  }
  return [...byLayer]
    .map(([layer, ys]) => ({
      layer,
      y: ys.reduce((sum, y) => sum + y, 0) / ys.length,
    }))
    .sort((a, b) => a.layer - b.layer);
}

/**
 * The latitude scale in the right margin: a tick at each dependency layer's
 * latitude and its number, the foundation (layer 0) to the south. Packages
 * the graph could not place are kept off the scale; their captions say so.
 * A margin note, like the grid references: it takes no part in label
 * collision.
 */
export function paintLatitudeScale(state: InkState): void {
  const { labelContext: ctx, legendHeight, view } = state;
  const ticks = layerLatitudes(state);
  if (!view || ticks.length === 0) {
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
  ctx.strokeStyle = style.hue;
  ctx.lineWidth = style.weight / pixels;
  ctx.beginPath();
  ctx.moveTo(x, Math.min(...ys));
  ctx.lineTo(x, Math.max(...ys));
  ctx.stroke();
  ctx.font = `${10 / pixels}px AtlasBody`;
  ctx.letterSpacing = `${1 / pixels}px`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const { layer, y } of visible) {
    ctx.strokeStyle = style.hue;
    ctx.lineWidth = style.weight / pixels;
    ctx.beginPath();
    ctx.moveTo(x - tick, y);
    ctx.lineTo(x + tick, y);
    ctx.stroke();
    const text = layer === 0 ? "FOUNDATION · 0" : `LAYER ${layer}`;
    ctx.lineWidth = 3 / pixels;
    ctx.strokeStyle = inks.labelHalo;
    ctx.strokeText(text, x - tick * 1.6, y);
    ctx.fillStyle = inks.scale;
    ctx.fillText(text, x - tick * 1.6, y);
  }
}
