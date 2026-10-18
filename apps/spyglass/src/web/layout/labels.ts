import type { SpyglassFile, Territory } from "../data/types";
import { chartTilt, type InkView } from "../view/chart-view";
import { flatMarkHeight } from "./terrain-height";

/** The chart's three typefaces: the display face for island names, the body face, and Georgia for region names and the sea's caption. */
export type LabelFace = "SpyglassDisplay" | "SpyglassBody" | "Georgia";

/** How a text is set, as far as its width depends on it: the face, italics, and the space between letters. */
export interface LabelFont {
  face: LabelFace;
  italic?: boolean;
  /** Letter-spacing as a share of the font size (em), so it follows the size at every zoom. */
  letterSpacing?: number;
}

/**
 * Measures a text set in a font: its advance width in em, the width at one
 * pixel of font size, so the width at any size is this times the size. The
 * scene's measurer reads the browser once per text and font; tests pass a
 * fake.
 */
export type TextMeasure = (text: string, font: LabelFont) => number;

/** What a label names, which decides how it is set, haloed and read. */
type LabelKind = "island" | "file" | "folder" | "region" | "domain" | "frame";

/**
 * A label the chart places: its text, its box in map units, how it is set,
 * and what it names. The box lies on the plane the marks are boxed on; a
 * label raised over the relief is boxed where it is seen, north of its
 * anchor by the lift (`liftedY`), so collision, the hit test and the
 * layers that clear around labels read it there, and `labelWorldPoint`
 * gives back the raised point the lettering is set at.
 */
export interface MapLabel {
  /** Small capitals printed beneath the name, e.g. a package's file count. */
  caption?: string;
  compositeId?: string;
  file?: SpyglassFile;
  font: LabelFont;
  /** The frame whose label this is, by id: a workspace's label above its frame, in spaced capitals. It has no island. */
  frame?: string;
  /** The paper halo the text is cut from, in CSS pixels. */
  halo: number;
  /** The font size, in map units. */
  height: number;
  /** The text's ink, from the ladder. */
  ink: string;
  kind: LabelKind;
  opacity?: number;
  regionId?: string;
  /** The island the label names or sits on; none for a frame's label. */
  territory?: Territory;
  text: string;
  width: number;
  x: number;
  /** The baseline's y on the plane, in map units. */
  y: number;
  /** The anchor's height in world units: the relief under a label on land, as a draped mark takes it; the sea plane otherwise. */
  z: number;
}

const lift = Math.tan(chartTilt);

/**
 * Where a baseline at `y` on the ground, raised to `z`, is seen on the
 * plane: north by the raise times the tilt's tangent, since the camera
 * looks south and down. Projecting either point lands on the same pixel.
 */
export function liftedY(y: number, z: number): number {
  return y - (z - flatMarkHeight) * lift;
}

/** The raised point a label's lettering is set at, in chart units (y south) and world height. */
export function labelWorldPoint(label: Pick<MapLabel, "x" | "y" | "z">): {
  x: number;
  y: number;
  z: number;
} {
  return {
    x: label.x,
    y: label.y + (label.z - flatMarkHeight) * lift,
    z: label.z,
  };
}

/**
 * The labels that fit: candidates in priority order, each kept when it lies
 * within the view and clears every label already placed by a gap.
 */
export function visibleLabels(
  candidates: MapLabel[],
  view: InkView
): MapLabel[] {
  const placed: MapLabel[] = [];
  const gap = (view.width < view.height ? 10 : 5) / view.pixelsPerUnit;
  for (const label of candidates) {
    if (
      label.x - label.width / 2 < view.x - view.width / 2 + gap ||
      label.x + label.width / 2 > view.x + view.width / 2 - gap ||
      label.y - label.height < view.y - view.height / 2 + gap ||
      label.y > view.y + view.height / 2 - gap
    ) {
      continue;
    }
    if (
      placed.some(
        (p) =>
          Math.abs(p.x - label.x) < (p.width + label.width) / 2 + gap &&
          label.y + gap > p.y - p.height &&
          label.y - label.height < p.y + gap
      )
    ) {
      continue;
    }
    placed.push(label);
  }
  return placed;
}
