/**
 * Splits a text into stretches a font can set and characters it lacks, so a
 * missing character is drawn as the crossed box and never falls back to a
 * system font.
 */
import { categoryOf } from "~/unicode/characters";

export type TextRun =
  | { readonly kind: "set"; readonly text: string }
  | { readonly kind: "missing"; readonly codePoint: number };

/**
 * Spaces, line breaks and format controls draw nothing, so no font has to
 * hold them. Private use and unassigned characters do draw: a font that lacks
 * one must show the crossed box.
 */
const drawsNothing = (codePoint: number) => {
  const category = categoryOf(codePoint);
  return category.startsWith("Z") || category === "Cc" || category === "Cf";
};

export const coveredRuns = (
  text: string,
  has: (codePoint: number) => boolean
): TextRun[] => {
  const runs: TextRun[] = [];
  let pending = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (has(codePoint) || drawsNothing(codePoint)) {
      pending += character;
      continue;
    }
    if (pending !== "") {
      runs.push({ kind: "set", text: pending });
      pending = "";
    }
    runs.push({ codePoint, kind: "missing" });
  }
  if (pending !== "") {
    runs.push({ kind: "set", text: pending });
  }
  return runs;
};
