/**
 * The port for reading letters. Any recogniser can stand behind it, and a
 * person can always put their own label over what it says.
 */
import type { LetteringLine, LetterShape } from "../isolation/letters";

export interface Guess {
  /** The Unicode code point the shape is taken for. */
  readonly character: number;
  /**
   * 0 to 1, for ranking and for deciding what to show a person first. It is
   * not a probability.
   */
  readonly confidence: number;
  /** The id of the reference the guess rests on, when there is one. */
  readonly reference?: string;
}

export interface Recognizer {
  readonly id: string;
  /**
   * For each letter of a line, in the line's order, the guesses for it, best
   * first. A letter nothing resembles gets an empty list. The whole line is
   * given because letters are read against each other: size against the
   * line's body height, width against the line's other letters.
   */
  recognise(line: LetteringLine): readonly (readonly Guess[])[];
}

/** One letter with what it was read as, and who said so. */
export interface Reading {
  /** The character the letter is taken for. Absent when nothing was recognised and nobody labelled it. */
  readonly character?: number;
  readonly guesses: readonly Guess[];
  /** The letter's place in its line. */
  readonly index: number;
  readonly labelledBy: "person" | "recognizer";
  readonly letter: LetterShape;
  /** The line's place in the region. */
  readonly line: number;
}

/** Reads every letter of every line. Each reading starts with the recogniser's best guess. */
export const readLettering = (
  lines: readonly LetteringLine[],
  recognizer: Recognizer
): Reading[] =>
  lines.flatMap((line, lineIndex) => {
    const guesses = recognizer.recognise(line);
    return line.letters.map(
      (letter, index): Reading => ({
        character: guesses[index]?.[0]?.character,
        guesses: guesses[index] ?? [],
        index,
        labelledBy: "recognizer",
        letter,
        line: lineIndex,
      })
    );
  });

/** A person's label for one letter. It replaces the recogniser's and keeps its guesses for the record. */
export const relabel = (reading: Reading, character: number): Reading => ({
  ...reading,
  character,
  labelledBy: "person",
});

export class LabelCountError extends Error {
  override readonly name = "LabelCountError";
}

/**
 * Labels letters from what a person typed, line by line. Spaces are skipped,
 * since a space is not a shape. The text must have one character for each
 * letter found: when it does not, some letter was missed or split, and
 * guessing which would mislabel the rest.
 */
export const labelFromText = (
  readings: readonly Reading[],
  text: readonly string[]
): Reading[] =>
  readings.map((reading) => {
    const typed = [...(text[reading.line] ?? "")].filter(
      (written) => written.trim() !== ""
    );
    const inLine = readings.filter(
      (other) => other.line === reading.line
    ).length;
    if (typed.length !== inLine) {
      throw new LabelCountError(
        `Line ${reading.line + 1} has ${inLine} letters and the text given for it has ${typed.length}. Label the letters one by one instead.`
      );
    }
    const character = typed[reading.index]?.codePointAt(0);
    return character === undefined ? reading : relabel(reading, character);
  });
