import { belongingMarks } from "../../layout/belonging-marks";
import {
  type BelongingViewOptions,
  belongingView,
  compositionInView,
  focusedFileInView,
} from "../../layout/belonging-view";
import { coastMarks } from "../../layout/coast-marks";
import { domainExtent } from "../../layout/domain-extent";
import { domainMarks } from "../../layout/domain-marks";
import { folderMarks } from "../../layout/folders";
import { chartGridMarks } from "../../layout/grid-marks";
import { seaRippleMarks } from "../../layout/ripple-marks";
import { drawnBelonging } from "../view-state";
import {
  keyedMarks,
  type MarkFrame,
  type MarkLayer,
  staticMarks,
} from "./mark-layer";

/** The belonging layer as this frame shows it: the applied layer under the hover and the reveal, resolved against the view. */
function belongingOptions({ state, view }: MarkFrame): BelongingViewOptions {
  return {
    belonging: drawnBelonging(state),
    fileId: state.selectedFile,
    matches: state.matches,
    responsibility: state.responsibility,
    selected: state.selected,
    territories: state.drawingData.territories,
    view,
  };
}

/**
 * The island whose cells the belonging layer may have rearranged, for the
 * layers that draw inside cells; a matched region leads on the island it is
 * on, so the view's belonging decides.
 */
function belongingTerritory(frame: MarkFrame) {
  return belongingView(belongingOptions(frame)).belonging?.territory ?? null;
}

/**
 * The chart's mark layers, bottom to top: the foot of the z-order under
 * every layer the ink canvas still paints (`scene/ink/layers.ts`). The
 * first three are static: built once from the chart's fixed geometry, or
 * from the islands and the selection, and only their alphas follow the
 * zoom. Belonging is built again as the applied layer, the hover's
 * emphasis, the reveal or the overlay changes, and as the zoom changes
 * while natural features are shown, since their pens follow it; the
 * folders and the domain are built once per chart and rearranged island.
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
  {
    id: "belonging",
    marks: keyedMarks(
      (frame) => {
        const { state, view } = frame;
        const options = belongingOptions(frame);
        return [
          state.belonging,
          state.belongingHover,
          state.belongingReveal,
          state.matches,
          state.responsibility,
          state.selected,
          state.selectedFile,
          state.drawingData.territories,
          state.settings.streams,
          focusedFileInView(options),
          compositionInView(options),
          state.belonging?.features ? view.pixelsPerUnit : 0,
        ];
      },
      (frame) => {
        const { state, view } = frame;
        const resolved = belongingView(belongingOptions(frame));
        return belongingMarks({
          activeRegion: resolved.activeRegion,
          baselineRegionId: resolved.baselineRegionId,
          belonging: resolved.belonging,
          districtFloor: resolved.districtFloor,
          hasComposition: resolved.hasComposition,
          matches: state.matches,
          pixels: view.pixelsPerUnit,
          responsibility: resolved.responsibility,
          streams: state.settings.streams,
        });
      }
    ),
  },
  {
    id: "folders",
    marks: keyedMarks(
      (frame) => [frame.state.drawingData, belongingTerritory(frame)],
      (frame) => {
        const territory = belongingTerritory(frame);
        return folderMarks(frame.state.drawingData, territory && { territory });
      }
    ),
  },
  {
    id: "domain",
    marks: keyedMarks(
      (frame) => [
        frame.state.drawingData,
        frame.state.domain,
        belongingTerritory(frame),
      ],
      (frame) => {
        const { domain, drawingData } = frame.state;
        const territory = belongingTerritory(frame);
        return domainMarks(
          drawingData,
          domain ? domainExtent(drawingData, domain) : null,
          territory && { territory }
        );
      }
    ),
  },
];
