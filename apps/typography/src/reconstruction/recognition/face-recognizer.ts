/**
 * The local recogniser: it compares each isolated letter with renderings of
 * candidate characters from reference faces the caller passes in. No model
 * and no network. Because it compares against faces, the same measurements
 * rank the faces by how well their glyphs agree with the letters: the
 * nearest faces. Nearest is all that is claimed, never an identification.
 */
import { median } from "~/generation/style/measure";
import type { AxisLocation } from "~/typeface/face";
import { outlineBounds } from "~/typeface/outline";
import type { OpenFace } from "~/typeface/reading";
import type { LetteringLine } from "../isolation/letters";
import {
  agreement,
  type NormalForm,
  normaliseLetter,
  normaliseOutline,
} from "./normal-form";
import type { Guess, Reading, Recognizer } from "./recognizer";

/** A face to compare against, at one axis location when it is variable. */
export interface ReferenceFace {
  readonly face: OpenFace;
  /** Unique among the references given. */
  readonly id: string;
  readonly location?: AxisLocation;
  /** What to call it in a report, for example Sofia Sans at weight 900. */
  readonly name: string;
}

export interface FaceMatch {
  /** Mean agreement between the face's glyphs and the letters, 0 to 1. */
  readonly agreement: number;
  /** How many letters the face has a glyph for and was compared on. */
  readonly letters: number;
  readonly name: string;
  readonly reference: string;
  /**
   * The middle of `widthFactors`, for a one-number summary. When the lines
   * differ it fits none of them: show `widthFactors` wherever there is room.
   */
  readonly widthFactor: number;
  /**
   * How far the face's glyphs were stretched across to fit each line, in
   * the order of the lines compared: below 1 the lettering is narrower than
   * the face, above 1 wider. Lines of one sign can be set at different
   * widths, so there is one factor for each and no single one for the face.
   */
  readonly widthFactors: readonly number[];
}

export interface FaceRecognizer extends Recognizer {
  /**
   * The reference faces ranked by how well their glyphs agree with the
   * letters as labelled, best first. A face that has none of the characters
   * is left out.
   */
  nearestFaces(
    lines: readonly LetteringLine[],
    readings: readonly Reading[]
  ): FaceMatch[];
}

export interface FaceRecognizerOptions {
  /** How many guesses to return for a letter. Five when absent. */
  readonly guesses?: number;
}

/**
 * The stretches tried for a face: steps of about one seventh from well under
 * half its width to half as wide again, then half a step either side of the
 * best. One is chosen for a whole line, so a narrow I is still narrow beside
 * a stretched M.
 */
const WIDTH_STEP = 1.14;
const WIDTH_FACTORS = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3].map(
  (step) => WIDTH_STEP ** step
);
const FINER = [WIDTH_STEP ** -0.5, WIDTH_STEP ** 0.5];
/** A lead this large over the next character makes a guess fully distinct. */
const CLEAR_LEAD = 0.1;
/** Agreement below this is no resemblance at all. */
const NO_RESEMBLANCE = 0.2;
const DEFAULT_GUESSES = 5;
/** How many of a letter's likeliest characters are compared again with slack. */
const SHORTLIST = 8;

interface Template {
  readonly character: number;
  readonly form: NormalForm;
}

interface LineFit {
  /** For each letter, the agreement with each template, in template order. */
  readonly scores: readonly (readonly number[])[];
  readonly templates: readonly Template[];
  readonly widthFactor: number;
}

const glyphOutline = ({ face, location }: ReferenceFace, character: number) => {
  const glyphId = face.glyphForCharacter(character);
  return glyphId === undefined
    ? undefined
    : face.glyph(glyphId, location).outline;
};

const BODY_LETTER = { "cap-height": "H", "x-height": "x" } as const;

/** The face's cap height or x-height, measured from its own H or x where it has one. */
const bodyHeightOf = (
  reference: ReferenceFace,
  body: LetteringLine["body"],
  characters: readonly number[]
): number => {
  const letter = glyphOutline(reference, BODY_LETTER[body].codePointAt(0) ?? 0);
  const measured = letter && outlineBounds(letter)?.yMax;
  if (measured) {
    return measured;
  }
  const { capHeight, xHeight } = reference.face.description.metrics;
  const declared = body === "cap-height" ? capHeight : xHeight;
  if (declared) {
    return declared;
  }
  // A face with no Latin and no declared line: the middle height of the
  // characters in question stands in for the body.
  const tops = characters.flatMap((character) => {
    const outline = glyphOutline(reference, character);
    const top = outline && outlineBounds(outline)?.yMax;
    return top ? [top] : [];
  });
  return median(tops) ?? reference.face.description.metrics.unitsPerEm * 0.7;
};

const confidenceOf = (score: number, runnerUp: number | undefined): number => {
  const lead = runnerUp === undefined ? CLEAR_LEAD : score - runnerUp;
  const distinct = Math.min(1, Math.max(0, lead / CLEAR_LEAD));
  return score * (0.5 + 0.5 * distinct);
};

/** Builds the local recogniser over reference faces and the characters to consider. */
export const createFaceRecognizer = (
  references: readonly ReferenceFace[],
  characters: readonly number[],
  options: FaceRecognizerOptions = {}
): FaceRecognizer => {
  const cache = new Map<string, readonly Template[]>();

  const templatesFor = (
    reference: ReferenceFace,
    body: LetteringLine["body"],
    widthFactor: number,
    wanted: readonly number[]
  ): readonly Template[] => {
    const key = `${reference.id}|${body}|${widthFactor}`;
    const known = cache.get(key) ?? [];
    const have = new Set(known.map((template) => template.character));
    const missing = wanted.filter((character) => !have.has(character));
    if (missing.length === 0) {
      return known.filter((template) => wanted.includes(template.character));
    }
    const bodyHeight = bodyHeightOf(reference, body, characters);
    const made = missing.flatMap((character): Template[] => {
      const outline = glyphOutline(reference, character);
      const form =
        outline && normaliseOutline(outline, bodyHeight, widthFactor);
      return form ? [{ character, form }] : [];
    });
    const all = [...known, ...made];
    cache.set(key, all);
    return all.filter((template) => wanted.includes(template.character));
  };

  /**
   * Fits one face to one line: tries each stretch, keeps the one under which
   * the letters agree best with the characters allowed for them, and scores
   * every letter against every template at that stretch.
   */
  const fitLine = (
    reference: ReferenceFace,
    line: LetteringLine,
    forms: readonly NormalForm[],
    allowed: (letter: number) => readonly number[]
  ): LineFit | undefined => {
    const wanted = [...new Set(forms.flatMap((_, letter) => allowed(letter)))];
    const totalAt = (widthFactor: number): number => {
      const templates = templatesFor(reference, line.body, widthFactor, wanted);
      let total = 0;
      for (const [letter, form] of forms.entries()) {
        const permitted = new Set(allowed(letter));
        let top = 0;
        for (const template of templates) {
          if (permitted.has(template.character)) {
            top = Math.max(top, agreement(form, template.form, 0));
          }
        }
        total += top;
      }
      return total;
    };
    let best: { total: number; widthFactor: number } | undefined;
    const consider = (widthFactor: number) => {
      const total = totalAt(widthFactor);
      if (!best || total > best.total) {
        best = { total, widthFactor };
      }
    };
    WIDTH_FACTORS.forEach(consider);
    const coarse = best?.widthFactor ?? 1;
    for (const finer of FINER) {
      consider(coarse * finer);
    }
    if (!best || best.total === 0) {
      return;
    }
    const templates = templatesFor(
      reference,
      line.body,
      best.widthFactor,
      wanted
    );
    return {
      scores: forms.map((form, letter) => {
        const permitted = new Set(allowed(letter));
        const rough = templates.map((template) =>
          permitted.has(template.character)
            ? agreement(form, template.form, 0)
            : 0
        );
        // Only the likeliest few are worth the slower comparison with slack.
        const cut = rough.toSorted((a, b) => b - a)[SHORTLIST - 1] ?? 0;
        return templates.map((template, index) =>
          (rough[index] ?? 0) >= cut && (rough[index] ?? 0) > 0
            ? agreement(form, template.form)
            : (rough[index] ?? 0)
        );
      }),
      templates,
      widthFactor: best.widthFactor,
    };
  };

  const guessesFor = (
    letter: number,
    fits: readonly { fit: LineFit; reference: ReferenceFace }[]
  ): Guess[] => {
    const best = new Map<number, { reference: string; score: number }>();
    for (const { fit, reference } of fits) {
      for (const [index, template] of fit.templates.entries()) {
        const score = fit.scores[letter]?.[index] ?? 0;
        if (score > (best.get(template.character)?.score ?? NO_RESEMBLANCE)) {
          best.set(template.character, { reference: reference.id, score });
        }
      }
    }
    const ranked = [...best.entries()]
      .toSorted(([, a], [, b]) => b.score - a.score)
      .slice(0, options.guesses ?? DEFAULT_GUESSES);
    return ranked.map(([character, { reference, score }], rank) => ({
      character,
      confidence:
        rank === 0 ? confidenceOf(score, ranked[1]?.[1].score) : score / 2,
      reference,
    }));
  };

  /** One face against one line as labelled: the agreement for each labelled letter the face has. */
  const matchLine = (
    reference: ReferenceFace,
    line: LetteringLine,
    labelled: readonly Reading[]
  ): { scores: number[]; widthFactor: number } | undefined => {
    const fit = fitLine(
      reference,
      line,
      labelled.map((reading) => normaliseLetter(reading.letter, line)),
      (letter) => {
        const character = labelled[letter]?.character;
        return character === undefined ? [] : [character];
      }
    );
    if (!fit) {
      return;
    }
    const scores = labelled.flatMap((reading, letter) => {
      const index = fit.templates.findIndex(
        (template) => template.character === reading.character
      );
      return index >= 0 ? [fit.scores[letter]?.[index] ?? 0] : [];
    });
    return { scores, widthFactor: fit.widthFactor };
  };

  const matchFace = (
    reference: ReferenceFace,
    lines: readonly LetteringLine[],
    readings: readonly Reading[]
  ): FaceMatch | undefined => {
    const matched = lines.flatMap((line, lineIndex) => {
      const labelled = readings.filter(
        (reading) =>
          reading.line === lineIndex && reading.character !== undefined
      );
      const match = matchLine(reference, line, labelled);
      return match ? [match] : [];
    });
    const scores = matched.flatMap((match) => match.scores);
    if (scores.length === 0) {
      return;
    }
    return {
      agreement: scores.reduce((sum, score) => sum + score, 0) / scores.length,
      letters: scores.length,
      name: reference.name,
      reference: reference.id,
      widthFactor: median(matched.map((match) => match.widthFactor)) ?? 1,
      widthFactors: matched.map((match) => match.widthFactor),
    };
  };

  return {
    id: "reference-faces",
    nearestFaces: (lines, readings) =>
      references
        .flatMap((reference) => matchFace(reference, lines, readings) ?? [])
        .toSorted((a, b) => b.agreement - a.agreement),
    recognise(line) {
      const forms = line.letters.map((letter) => normaliseLetter(letter, line));
      const fits = references.flatMap((reference) => {
        const fit = fitLine(reference, line, forms, () => characters);
        return fit ? [{ fit, reference }] : [];
      });
      return forms.map((_, letter) => guessesFor(letter, fits));
    },
  };
};
