import { paintBoundaries } from "../boundaries";
import { paintHoverInk } from "../hover-ink";
import { paintChartGrid, paintGridReferences } from "../paint-paper";
import { paintSeaRipples } from "../sea-ripples";
import { paintSelectionInk } from "../selection-ink";
import { paintTopography } from "../topography";
import { paintBelonging } from "./belonging";
import { paintCoastline } from "./coast-ink";
import { paintChartCompass } from "./compass";
import { paintConnections } from "./connections";
import { paintDepartures } from "./departures";
import { paintFocusedFile } from "./file-focus";
import { paintFiles } from "./files";
import { paintMapLabels } from "./labels";
import { paintLatitudeScale } from "./latitude-scale";
import { paintProximity } from "./proximity";
import { paintResponsibilityOverlay } from "./responsibility";
import { paintSeaCaption } from "./sea-caption";
import type { InkState } from "./state";

/** One ink layer: what it is called when timed, and how it paints from the repaint's state. */
export interface InkLayer {
  id: string;
  paint: (state: InkState) => void;
}

/**
 * The ink canvas's layers, bottom to top: this order is the map's z-order.
 * `paintInk` saves and restores the context around each, so a layer starts
 * from the scene's drawing state and never inherits another's.
 */
export const inkLayers = [
  {
    id: "chart-grid",
    paint: ({ ctx, data, view }) => view && paintChartGrid(ctx, view, data),
  },
  {
    id: "sea-ripples",
    paint: ({ ctx, ripples, view }) =>
      view && paintSeaRipples(ctx, ripples, view),
  },
  { id: "coast", paint: paintCoastline },
  { id: "belonging", paint: paintBelonging },
  { id: "connections", paint: paintConnections },
  { id: "files", paint: paintFiles },
  { id: "responsibility", paint: paintResponsibilityOverlay },
  { id: "proximity", paint: paintProximity },
  { id: "file-focus", paint: paintFocusedFile },
  { id: "labels", paint: paintMapLabels },
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
  { id: "departures", paint: paintDepartures },
  {
    id: "selection",
    paint: ({ ctx, data, labels, selected, view }) =>
      view &&
      paintSelectionInk(ctx, data, selected, view.pixelsPerUnit, labels),
  },
  {
    id: "grid-references",
    paint: ({ data, labelContext, labels, view }) =>
      view && paintGridReferences(labelContext, view, data, labels),
  },
  { id: "latitude-scale", paint: paintLatitudeScale },
  { id: "compass", paint: paintChartCompass },
  { id: "sea-caption", paint: paintSeaCaption },
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
