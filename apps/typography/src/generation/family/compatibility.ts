/**
 * Whether the candidates made for one glyph on several faces can be masters
 * of one variable glyph. That takes the same drawing in every face: as many
 * contours, as many segments in each, and the same kind of segment at every
 * place. Where the points sit is free. That is what interpolates.
 *
 * The build engine has the last word. It rounds to whole font units and
 * converts cubic curves, and it refuses, naming the glyph, in the rare case
 * where that leaves one master with a point another does not have.
 */

import { count } from "~/lib/count";
import type { Outline, Segment } from "~/typeface/outline";

/** One face's drawing of a glyph, or the reason it has none. */
export type MemberDrawing =
  | { readonly label: string; readonly outline: Outline }
  | { readonly label: string; readonly missing: string };

export interface Compatibility {
  readonly compatible: boolean;
  /** Why the drawings cannot interpolate. Absent when they can. */
  readonly reason?: string;
}

const KIND_NAMES: Readonly<Record<Segment["kind"], string>> = {
  cubic: "a cubic curve",
  line: "a line",
  quadratic: "a quadratic curve",
};

/** What differs between two drawings, in words, or nothing when they match. */
const differenceBetween = (
  first: { readonly label: string; readonly outline: Outline },
  other: { readonly label: string; readonly outline: Outline }
): string | undefined => {
  const [a, b] = [first.outline.contours, other.outline.contours];
  if (a.length !== b.length) {
    return `${first.label} has ${count(a.length, "contour")} and ${other.label} has ${b.length}.`;
  }
  for (const [index, contour] of a.entries()) {
    const [mine, theirs] = [contour.segments, b[index]?.segments ?? []];
    if (mine.length !== theirs.length) {
      return `Contour ${index + 1} has ${count(mine.length, "segment")} in ${first.label} and ${theirs.length} in ${other.label}.`;
    }
    const at = mine.findIndex(
      (segment, place) => segment.kind !== theirs[place]?.kind
    );
    const [here, there] = [mine[at], theirs[at]];
    if (here && there) {
      return `Contour ${index + 1} has ${KIND_NAMES[here.kind]} in ${first.label} where ${other.label} has ${KIND_NAMES[there.kind]}.`;
    }
  }
};

/** Compares every face's drawing of one glyph with the first face's. */
export const compatibilityOf = (
  drawings: readonly MemberDrawing[]
): Compatibility => {
  const absent = drawings.find((drawing) => "missing" in drawing);
  if (absent && "missing" in absent) {
    return {
      compatible: false,
      reason: `${absent.label} has no candidate. ${absent.missing}`,
    };
  }
  const drawn = drawings.filter((drawing) => "outline" in drawing);
  const [first, ...others] = drawn;
  if (!first) {
    return { compatible: false, reason: "No face has a candidate." };
  }
  for (const other of others) {
    const reason = differenceBetween(first, other);
    if (reason) {
      return { compatible: false, reason };
    }
  }
  return { compatible: true };
};
