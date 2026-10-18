import type { SpyglassFile, Territory } from "../data/types";
import type { InkView } from "../view/chart-view";

/** A label the chart places: its text, its box in map units, and what it names. */
export interface MapLabel {
  /** Small capitals printed beneath the name, e.g. a package's file count. */
  caption?: string;
  compositeId?: string;
  /** The chosen domain's name, in the domain's ink. */
  domain?: boolean;
  file?: SpyglassFile;
  /** A folder's name, set in italics in the folder ink. */
  folder?: boolean;
  font: string;
  /** The frame whose label this is, by id: a workspace's label above its frame, in spaced capitals. It has no island. */
  frame?: string;
  height: number;
  opacity?: number;
  regionId?: string;
  /** The island the label names or sits on; none for a frame's label. */
  territory?: Territory;
  text: string;
  width: number;
  x: number;
  y: number;
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
