/** Turns a scope, or a list of found characters, into the headed sections of the grid. */
import { isCovered } from "~/library/face-coverage";
import { formatCodePoint } from "~/unicode/code-point";
import type { Classifier } from "~/unicode/coverage";
import { blockSections, type Scope } from "~/unicode/scope";
import type { GridSection } from "./grid-layout";

const countCovered = (characters: Uint32Array, classify: Classifier) => {
  let covered = 0;
  for (const codePoint of characters) {
    if (isCovered(classify(codePoint))) {
      covered += 1;
    }
  }
  return covered;
};

const inFace = (characters: Uint32Array, classify: Classifier) =>
  `${countCovered(characters, classify)} of ${characters.length} in the face`;

/** A scope's characters sectioned by Unicode block, in code point order. */
export const scopeSections = (
  scope: Scope,
  classify: Classifier
): GridSection[] =>
  blockSections(scope).map(({ block, characters }) => ({
    characters,
    detail: block
      ? `${formatCodePoint(block.first)} to ${formatCodePoint(block.last)}, ${inFace(characters, classify)}`
      : inFace(characters, classify),
    key: block?.name ?? "outside",
    title: block?.name ?? "Outside any block",
  }));

/** Search results as one section, kept in the order the search ranked them. */
export const resultSections = (
  codePoints: readonly number[],
  classify: Classifier
): GridSection[] => {
  if (codePoints.length === 0) {
    return [];
  }
  const characters = Uint32Array.from(codePoints);
  return [
    {
      characters,
      detail: inFace(characters, classify),
      key: "results",
      title:
        characters.length === 1
          ? "1 character found"
          : `${characters.length} characters found`,
    },
  ];
};
