import type {
  SpyglassData,
  SpyglassFile,
  SpyglassFrame,
  Territory,
} from "../data/types";
import { chartTilt, type InkView } from "../view/chart-view";
import type { detailLevel } from "../view/detail-level";
import type { BelongingLayer } from "./belonging";
import type { DomainExtent } from "./domain-extent";
import type { ResponsibilityOverlay } from "./responsibility-focus";
import { flatMarkHeight, type ReliefOf } from "./terrain-height";

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
  belonging: BelongingLayer | null;
  composition?: ResponsibilityOverlay["composition"];
  data: SpyglassData;
  detail: ReturnType<typeof detailLevel>;
  domain: DomainExtent | null;
  /** The files the names keep to: an overlay's evidence, or the active group's members (`labelEvidence`). */
  evidenceFiles?: Set<string>;
  fileId: string | null;
  /** The island whose relief is drawn, for a label's island as drawn: a name on land sits on that relief, as the marks do. */
  reliefOf: ReliefOf;
  selected: string | null;
  view: InkView;
}

/**
 * The place a label names, which selecting the label selects: an island,
 * a file on it, or a region or composite of its belonging layer. The same
 * shape the scene's handle hands to a label activation.
 */
export interface LabelPlace {
  compositeId?: string;
  file?: SpyglassFile;
  regionId?: string;
  territory: Territory;
}

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

/** A folder's name on its island; selecting it selects the island. */
interface FolderLabel extends LabelBox {
  kind: "folder";
  place: LabelPlace;
  territory: Territory;
}

/** A region's or a composite's name on the belonging island; its place carries which. */
interface RegionLabel extends LabelBox {
  kind: "region";
  place: LabelPlace;
  territory: Territory;
}

/** The chosen domain's name, over the island of its largest piece in view: a caption, not a place, so a click passes through it. */
interface DomainLabel extends LabelBox {
  kind: "domain";
  place?: undefined;
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
export type MapLabel =
  | IslandLabel
  | FileLabel
  | FolderLabel
  | RegionLabel
  | DomainLabel
  | FrameLabel;

/**
 * Where a baseline at `y` on the ground, raised to `z`, is seen on the
 * plane: north by the raise times the tilt's tangent, since the camera
 * looks south and down. Projecting either point lands on the same pixel.
 */
export function liftedY(y: number, z: number, tilt = chartTilt): number {
  return y - (z - flatMarkHeight) * Math.tan(tilt);
}

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
