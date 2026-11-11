/**
 * Splits text into stretches a font can set and the characters it lacks, so
 * a missing character is drawn as the crossed box and the browser never
 * reaches for a system fallback font.
 */
import { drawsNothing } from "./characters";

/** `start` is the index of the run's first UTF-16 code unit in the text. */
export type TextRun =
  | { readonly kind: "text"; readonly start: number; readonly text: string }
  | {
      readonly kind: "missing";
      readonly codePoint: number;
      readonly start: number;
    };

/**
 * Text runs are kept whole, so shaping inside them is untouched. `has` says
 * whether the font holds a character.
 */
export const splitRuns = (
  text: string,
  has: (codePoint: number) => boolean
): TextRun[] => {
  const runs: TextRun[] = [];
  let pending = "";
  let index = 0;
  const flush = () => {
    if (pending !== "") {
      runs.push({ kind: "text", start: index - pending.length, text: pending });
      pending = "";
    }
  };
  for (const symbol of text) {
    const codePoint = symbol.codePointAt(0) ?? 0;
    if (has(codePoint) || drawsNothing(codePoint)) {
      pending += symbol;
    } else {
      flush();
      runs.push({ codePoint, kind: "missing", start: index });
    }
    index += symbol.length;
  }
  flush();
  return runs;
};

export const countMissing = (runs: readonly TextRun[]) =>
  runs.filter((run) => run.kind === "missing").length;
