import { paperThickness } from "../data/bindings";
import type {
  SpyglassData,
  SpyglassFile,
  SpyglassFrame,
  Territory,
} from "../data/types";
import { chartTilt, type InkView } from "../view/chart-view";
import type { detailLevel } from "../view/detail-level";

/**
 * The height every label's anchor is given in the labels' own model: just
 * above the paper. The map raises each onto the land it draws when it
 * projects it (`islands-host/map-view.ts` `projectionOf`).
 */
export const flatMarkHeight = paperThickness + 0.02;

/** The chart's three typefaces: the display face for island names, the body face, and Georgia for region names and the sea's caption. */
export type LabelFace = "SpyglassDisplay" | "SpyglassBody" | "Georgia";

/** How a text is set, as far as its width depends on it: the face, italics, and the space between letters. */
export interface LabelFont {
  face: LabelFace;
  italic?: boolean;
  /** Letter-spacing as a share of the font size (em), so it follows the size at every zoom; 0 for a face set as it comes. */
  letterSpacing: number;
}

/**
 * Measures a text set in a font: its advance width in em, the width at one
 * pixel of font size, so the width at any size is this times the size. The
 * scene's measurer reads the browser once per text and font; tests pass a
 * fake.
 */
export type TextMeasure = (text: string, font: LabelFont) => number;

/** What the labels are proposed from: the chart's state as one frame shows it. */
export interface LabelInputs {
  data: SpyglassData;
  detail: ReturnType<typeof detailLevel>;
  fileId: string | null;
  selected: string | null;
  view: InkView;
}

/**
 * The place a label names, which selecting the label selects: an island,
 * or a file on it.
 */
export interface LabelPlace {
  file?: SpyglassFile;
  territory: Territory;
}

/** Called when Enter or Space is pressed on a focused label item. */
export type LabelActivation = (place: LabelPlace) => void;

/** A file's name's place: the file, on its island. */
interface FilePlace extends LabelPlace {
  file: SpyglassFile;
}

/**
 * What every label carries: its text, its box in map units, how it is
 * set, and its anchor's height. The box lies on the plane the marks are
 * boxed on; a label raised over the relief is boxed where it is seen,
 * north of its anchor by the lift (`liftedY`), so collision, the hit test
 * and the layers that clear around labels read it there, and
 * `labelWorldPoint` gives back the raised point the lettering is set at.
 */
interface LabelBox {
  font: LabelFont;
  /** The paper halo the text is cut from, in CSS pixels. */
  halo: number;
  /** The font size, in map units. */
  height: number;
  /** The text's ink, from the ladder. */
  ink: string;
  opacity: number;
  text: string;
  width: number;
  x: number;
  /** The baseline's y on the plane, in map units. */
  y: number;
  /** The anchor's height in world units: the relief under a label on land, as a draped mark takes it; the sea plane otherwise. */
  z: number;
}

/** An island's name, with its caption beneath: small capitals, e.g. the package's file count. */
export interface IslandLabel extends LabelBox {
  caption: string;
  kind: "island";
  place: LabelPlace;
  territory: Territory;
}

/** A file's name, on the file's island. */
interface FileLabel extends LabelBox {
  kind: "file";
  place: FilePlace;
  territory: Territory;
}

/** A workspace's label above its frame, in spaced capitals: a caption with no island, which a click passes through. */
interface FrameLabel extends LabelBox {
  frame: SpyglassFrame;
  kind: "frame";
  place?: undefined;
  territory?: undefined;
}

/**
 * A label the chart places, by what it names. One with a `place` is
 * selectable: the hit test and a keyboard activation select that place.
 * `territory` is the island the label sits on, for its lift over the
 * relief and its item in the island's list.
 */
export type MapLabel = IslandLabel | FileLabel | FrameLabel;

/** The raised point a label's lettering is set at, in chart units (y south) and world height. */
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

/** Upright text occupies more map-plane height as the camera tilts. */
export function labelPlaneHeight(
  label: Pick<MapLabel, "height">,
  view: InkView
): number {
  return label.height / (view.tilt === undefined ? 1 : Math.cos(view.tilt));
}

/** A rectangle reserved for the viewer's controls, which no label overlaps: in CSS pixels from the canvas's top left. */
export interface LabelExclusion {
  bottom: number;
  left: number;
  right: number;
  top: number;
}
