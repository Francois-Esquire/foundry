import { coastMarks } from "../../layout/coast-marks";
import { chartGridMarks } from "../../layout/grid-marks";
import { seaRippleMarks } from "../../layout/ripple-marks";
import { type MarkLayer, staticMarks } from "./mark-layer";

/**
 * The chart's mark layers, bottom to top: the foot of the z-order under
 * every layer the ink canvas still paints (`scene/ink/layers.ts`). Each is
 * static: built once from the chart's fixed geometry, or from the islands
 * and the selection, and only its alphas follow the zoom.
 */
export const markLayers: readonly MarkLayer[] = [
  {
    id: "chart-grid",
    marks: staticMarks((frame) => [frame.chart.sea] as const, chartGridMarks),
  },
  {
    id: "sea-ripples",
    marks: staticMarks(
      (frame) => [frame.chart.ripples] as const,
      seaRippleMarks
    ),
  },
  {
    id: "coast",
    marks: staticMarks(
      (frame) =>
        [frame.state.drawingData.territories, frame.state.selected] as const,
      coastMarks
    ),
  },
];
