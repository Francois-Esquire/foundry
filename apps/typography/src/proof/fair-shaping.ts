/**
 * Asks a source font and the font derived from it the same question, so the
 * answers can be compared. The source is shaped at the same instance and
 * without the features the derived font was built without.
 *
 * The rule is the one `checkSample` in packaging applies for its verdict;
 * packaging does not export these steps, so they are repeated here.
 */
import type { BuildRequest } from "~/packaging/building";
import type { ShapingSample } from "~/packaging/shaping-retention";
import type { OpenFace, ShapeOptions } from "~/typeface/reading";

export interface FairOptions {
  /** What the derived font is asked. */
  readonly derived: ShapeOptions;
  /** What the source font is asked. */
  readonly source: ShapeOptions;
}

const droppedFeatures = (source: OpenFace, request: BuildRequest) => {
  const kept = request.subset?.features;
  if (!kept) {
    return {};
  }
  const { positioning, substitution } = source.description.layout;
  return Object.fromEntries(
    [...positioning, ...substitution]
      .filter((tag) => !kept.includes(tag))
      .map((tag) => [tag, false])
  );
};

export const fairOptions = (
  source: OpenFace,
  request: BuildRequest,
  sample: ShapingSample
): FairOptions => ({
  derived: { ...sample.options },
  source: {
    ...sample.options,
    features: {
      ...droppedFeatures(source, request),
      ...sample.options?.features,
    },
    location: request.location ?? sample.options?.location,
  },
});

/** The characters of a text that every one of the faces holds. */
export const keptPart = (text: string, faces: readonly OpenFace[]) =>
  [...text]
    .filter((character) =>
      faces.every(
        (face) =>
          face.glyphForCharacter(character.codePointAt(0) ?? 0) !== undefined
      )
    )
    .join("");
