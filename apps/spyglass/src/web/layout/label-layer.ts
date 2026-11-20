import type { InkView } from "../view/chart-view";
import type { FileAt } from "../view/file-place";
import type { LabelActivation, MapLabel } from "./labels";
import type { ViewState } from "./view-state";

export type LabelProjection = (
  view: InkView
) => (x: number, y: number, z: number) => { x: number; y: number };

export interface LabelLayerInputs {
  fileAt?: FileAt;
  pixelRatio: () => number;
  project: LabelProjection;
  publish: (labels: MapLabel[]) => void;
}

export interface LabelLayer {
  dispose: () => void;
  id: string;
  kind: "labels";
  setActivation: (handler: LabelActivation | null) => void;
  setVisible: (visible: boolean) => void;
  stats: () => Record<string, number>;
  update: (view: InkView, state: Readonly<ViewState>, time: number) => void;
  updateAnnotations: (
    view: InkView,
    state: Readonly<ViewState>,
    time: number
  ) => void;
}
