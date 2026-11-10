/**
 * Which variable faces of a project could be rebuilt as a variable font: the
 * ones with two or more pinned instances at different weights. A face with
 * fewer is listed with the reason, so the screen can say what is missing.
 */
import { type Face, faceStyleName, isVariable } from "~/typeface/face";
import type { TypefaceProject } from "~/typeface/project";

const WEIGHT = "wght";

export interface MasterGroup {
  /** The source's family name. */
  readonly familyName: string;
  /** Stable for a variable face: its own id. */
  readonly key: string;
  /** Present only when a variable font can be offered. */
  readonly offered: boolean;
  /** The face's pinned instances, lightest first. */
  readonly pinned: readonly Face[];
  /** Why no variable font is offered. Absent when one is. */
  readonly reason?: string;
}

/** Where a pinned instance sits on the weight axis. */
export const weightOf = (face: Face): number | undefined =>
  face.pinned?.location[WEIGHT];

const reasonFor = (
  variable: Face,
  pinned: readonly Face[],
  weights: number
): string | undefined => {
  const name = variable.description.familyName;
  if (!variable.description.axes.some((axis) => axis.tag === WEIGHT)) {
    return `${name} has no weight axis, and a variable font is rebuilt along the weight axis only. Its pinned instances export as static fonts.`;
  }
  if (weights > 1) {
    return;
  }
  const [only] = pinned;
  const have =
    pinned.length === 1 && only
      ? `one pinned instance, ${faceStyleName(only)}`
      : `${pinned.length} pinned instances at one weight`;
  return `${name} has ${have}. A variable font needs at least two, pinned at different weights. Pin another in the Studio, or generate across weights in Generate.`;
};

/** Every variable face that has pinned instances, in the order of the project. */
export const masterGroups = (project: TypefaceProject): MasterGroup[] =>
  project.faces.filter(isVariable).flatMap((variable): MasterGroup[] => {
    const pinned = project.faces
      .filter(
        (face) =>
          face.pinned &&
          face.sourceId === variable.sourceId &&
          face.index === variable.index
      )
      .toSorted((a, b) => (weightOf(a) ?? 0) - (weightOf(b) ?? 0));
    if (pinned.length === 0) {
      return [];
    }
    const weights = new Set(pinned.map(weightOf)).size;
    const reason = reasonFor(variable, pinned, weights);
    return [
      {
        familyName: variable.description.familyName,
        key: variable.id,
        offered: reason === undefined,
        pinned,
        reason,
      },
    ];
  });
