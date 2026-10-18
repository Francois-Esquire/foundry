import { paintBoundaries } from "../boundaries";
import { paintHoverInk } from "../hover-ink";
import { paintSelectionInk } from "../selection-ink";
import { paintTopography } from "../topography";
import { paintChartCompass } from "./compass";
import { paintCrossings } from "./crossings";
import { paintDepartures } from "./departures";
import { paintDomainDepartures } from "./domain";
import type { InkState } from "./state";

/** One ink layer: what it is called when timed, and how it paints from the repaint's state. */
export interface InkLayer {
  id: string;
  paint: (state: InkState) => void;
}

/**
 * The ink canvas's layers, bottom to top: this order is the map's z-order
 * above the mark layers (`scene/marks/layers.ts`), which hold its foot: the
 * grid, the ripples, the coast, the belonging pigment with its natural
 * features, the folder cuts, the domain's band and marks, the traced
 * imports, the file marks, the responsibility overlay, proximity and the
 * selected file's focus draw as GPU marks under all of these. Every string
 * on the chart is lettered by the labels layer (`scene/labels/`), as
 * elements over the canvas: the placed labels reach these layers on the
 * state, so topography and the selection clear around them and the hover
 * tests them first. `paintInk` saves and restores the context around each
 * layer, so a layer starts from the scene's drawing state and never
 * inherits another's.
 */
export const inkLayers = [
  {
    id: "topography",
    paint: ({ ctx, detail, labels, topography, view }) => {
      if (!view) {
        return;
      }
      ctx.save();
      ctx.globalAlpha = 1 - detail.composition * 0.8;
      paintTopography(ctx, topography, view, labels);
      ctx.restore();
    },
  },
  { id: "crossings", paint: paintCrossings },
  { id: "departures", paint: paintDepartures },
  { id: "domain-departures", paint: paintDomainDepartures },
  {
    id: "selection",
    paint: ({ ctx, data, labels, selected, view }) =>
      view &&
      paintSelectionInk(ctx, data, selected, view.pixelsPerUnit, labels),
  },
  { id: "compass", paint: paintChartCompass },
  {
    id: "boundaries",
    paint: ({ boundaries, ctx, pixels }) =>
      boundaries &&
      paintBoundaries(ctx, boundaries.layers, boundaries.visible, pixels),
  },
  {
    id: "hover",
    paint: ({ ctx, hovered, labels, pixels }) =>
      hovered && paintHoverInk(ctx, hovered(labels), pixels),
  },
] as const satisfies readonly InkLayer[];
