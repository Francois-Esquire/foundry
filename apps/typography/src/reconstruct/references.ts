/**
 * The faces of the library as references to read lettering against. A static
 * face stands in once. A variable face stands in at its default and at both
 * ends of its weight axis, because lettering on a sign is seldom regular.
 */
import {
  type AxisLocation,
  defaultLocation,
  type Face,
  faceStyleName,
  isVariable,
  locationKey,
} from "~/typeface/face";
import type { OpenFace } from "~/typeface/reading";
import type { ReferenceFace } from "./core";

const WEIGHT = "wght";

const locationsOf = (face: Face): (AxisLocation | undefined)[] => {
  if (!isVariable(face)) {
    return [undefined];
  }
  const { axes } = face.description;
  const standard = defaultLocation(axes);
  const weight = axes.find((axis) => axis.tag === WEIGHT);
  if (!weight) {
    return [standard];
  }
  const weights = [...new Set([weight.default, weight.min, weight.max])];
  return weights.map((value) => ({ ...standard, [WEIGHT]: value }));
};

const nameOf = (face: Face, location: AxisLocation | undefined) => {
  const weight = location?.[WEIGHT];
  return weight === undefined
    ? `${face.description.familyName} ${faceStyleName(face)}`
    : `${face.description.familyName} at weight ${weight}`;
};

/**
 * One reference for each face and location that draws at least one of the
 * characters under consideration. A face that draws none, such as the blank
 * face of a reconstruction, could match nothing and is left out.
 */
export const referenceFaces = (
  faces: readonly Face[],
  open: (face: Face) => OpenFace,
  characters: readonly number[]
): ReferenceFace[] =>
  faces.flatMap((face) => {
    const opened = open(face);
    if (
      !characters.some(
        (character) => opened.glyphForCharacter(character) !== undefined
      )
    ) {
      return [];
    }
    return locationsOf(face).map(
      (location): ReferenceFace => ({
        face: opened,
        id: location ? `${face.id}@${locationKey(location)}` : face.id,
        location,
        name: nameOf(face, location),
      })
    );
  });

/** Tells one set of references from another, so letters are read again only when it changes. */
export const referencesKey = (references: readonly ReferenceFace[]) =>
  references.map((reference) => reference.id).join("|");
