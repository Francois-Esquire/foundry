import { paperThickness } from "../data/bindings";
import type {
  SpyglassData,
  SpyglassFile,
  SpyglassFrame,
  Territory,
} from "../data/types";
import { chartTilt, type InkView } from "../view/chart-view";
import type { detailLevel } from "../view/detail-level";
import type { FileAt } from "../view/file-place";

export const flatMarkHeight = paperThickness + 0.02;

export type LabelFace = "SpyglassDisplay" | "SpyglassBody" | "Georgia";

export interface LabelFont {
  face: LabelFace;
  italic?: boolean;
  letterSpacing: number;
}

export type TextMeasure = (text: string, font: LabelFont) => number;

export interface LabelInputs {
  data: SpyglassData;
  detail: ReturnType<typeof detailLevel>;
  fileAt?: FileAt;
  fileId: string | null;
  selected: string | null;
  view: InkView;
}

export interface LabelPlace {
  file?: SpyglassFile;
  territory: Territory;
}

export type LabelActivation = (place: LabelPlace) => void;

interface FilePlace extends LabelPlace {
  file: SpyglassFile;
}

interface LabelBox {
  font: LabelFont;
  halo: number;
  height: number;
  ink: string;
  opacity: number;
  text: string;
  width: number;
  x: number;
  y: number;
  z: number;
}

export interface IslandLabel extends LabelBox {
  caption: string;
  kind: "island";
  place: LabelPlace;
  territory: Territory;
}

interface FileLabel extends LabelBox {
  kind: "file";
  place: FilePlace;
  territory: Territory;
}

interface FrameLabel extends LabelBox {
  frame: SpyglassFrame;
  kind: "frame";
  place?: undefined;
  territory?: undefined;
}

export type MapLabel = IslandLabel | FileLabel | FrameLabel;

export function labelWorldPoint(
  label: Pick<MapLabel, "x" | "y" | "z">,
  tilt = chartTilt
): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: label.x,
    y: label.y + (label.z - flatMarkHeight) * Math.tan(tilt),
    z: label.z,
  };
}

export function labelPlaneHeight(
  label: Pick<MapLabel, "height">,
  view: InkView
): number {
  return label.height / (view.tilt === undefined ? 1 : Math.cos(view.tilt));
}

export interface LabelExclusion {
  bottom: number;
  left: number;
  right: number;
  top: number;
}
