import type { InkView } from "../view/chart-view";
import type { LabelActivation, MapLabel } from "./labels";
import type { ViewState } from "./view-state";

/**
 * How a frame's chart points reach the screen, for the labels laid over the
 * map: asked once per frame with the frame's view, it gives the projection
 * the labels and the chrome place themselves with. A chart point is `x`
 * east and `y` south in map units, `z` the height the labels' own model
 * gives it; the answer is in CSS pixels from the map's top left. The map
 * supplies it from Islands' `project`, on the land's own height.
 */
export type LabelProjection = (
  view: InkView
) => (x: number, y: number, z: number) => { x: number; y: number };

/** Projection and interaction inputs supplied to the host's label renderer. */
export interface LabelLayerInputs {
  pixelRatio: () => number;
  project: LabelProjection;
  publish: (labels: MapLabel[]) => void;
}

/**
 * The DOM labels over the map, as the map updates them: once a frame with
 * its view and state, and the annotations (chrome) even while the map's
 * labels are hidden. It renders to the DOM, so it has no mesh.
 */
export interface LabelLayer {
  dispose: () => void;
  id: string;
  kind: "labels";
  setActivation: (handler: LabelActivation | null) => void;
  /** Applies visibility to the labels' elements. */
  setVisible: (visible: boolean) => void;
  /** What the layer holds, for its node in the composition: labels proposed, placed and lettered. */
  stats: () => Record<string, number>;
  /** Brings the labels up to date with the view and the state. */
  update: (view: InkView, state: Readonly<ViewState>, time: number) => void;
  /** Viewport annotations update independently of map-label visibility. */
  updateAnnotations: (
    view: InkView,
    state: Readonly<ViewState>,
    time: number
  ) => void;
}
