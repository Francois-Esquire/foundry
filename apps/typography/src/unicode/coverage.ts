/**
 * Coverage: for a face and a scope, which characters are in the source,
 * edited, added, candidates, or missing. This module never opens a font; the
 * caller hands it what the face holds.
 */
import type { WorkingFace } from "~/typeface/changes";
import type { Candidate } from "~/typeface/project";
import { charactersIn, type Scope, scopeName, scopeOf } from "./scope";

export type CharacterStatus =
  | "source"
  | "edited"
  | "added"
  | "candidate"
  | "missing";

export type Classifier = (codePoint: number) => CharacterStatus;

type StatusCounts = Readonly<Record<CharacterStatus, number>>;

interface CoverageSummary {
  readonly counts: StatusCounts;
  /** Characters the face can set: source, edited and added. */
  readonly covered: number;
  /** Covered as a share of the total, 0 to 100. 0 for an empty scope. */
  readonly percent: number;
  readonly total: number;
}

export interface CharacterCoverage {
  readonly codePoint: number;
  readonly status: CharacterStatus;
}

export interface Coverage extends CoverageSummary {
  /** Every character of the scope in code point order. */
  readonly characters: readonly CharacterCoverage[];
}

const emptyCounts = (): Record<CharacterStatus, number> => ({
  added: 0,
  candidate: 0,
  edited: 0,
  missing: 0,
  source: 0,
});

const summarise = (counts: StatusCounts, total: number): CoverageSummary => {
  const covered = counts.source + counts.edited + counts.added;
  return {
    counts,
    covered,
    percent: total === 0 ? 0 : (covered / total) * 100,
    total,
  };
};

/** The coverage of a scope, character by character. */
export const coverageOf = (scope: Scope, classify: Classifier): Coverage => {
  const counts = emptyCounts();
  const characters: CharacterCoverage[] = [];
  for (const codePoint of charactersIn(scope)) {
    const status = classify(codePoint);
    counts[status] += 1;
    characters.push({ codePoint, status });
  }
  return { ...summarise(counts, characters.length), characters };
};

/** What a face holds, as plain data read from the typeface model. */
export interface FaceCharacters {
  /** The face's proposed candidates. */
  readonly candidates: readonly Pick<Candidate, "characters">[];
  /** The source glyph a character maps to, as `OpenFace.glyphForCharacter` answers. */
  readonly glyphForCharacter: (codePoint: number) => number | undefined;
  /** The source character set, ascending, as `OpenFace.characters()` returns it. */
  readonly source: Uint32Array;
  readonly working: WorkingFace;
}

export interface FaceClassification {
  /** Every character that is not missing, ascending. */
  readonly characters: Uint32Array;
  readonly classify: Classifier;
}

const includes = (sorted: Uint32Array, codePoint: number) => {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = sorted[middle] ?? 0;
    if (value === codePoint) {
      return true;
    }
    if (value < codePoint) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return false;
};

/**
 * Builds the classifier for one face. A character mapped by an added glyph is
 * "added", even where the source also had it. A source character whose glyph
 * has an override is "edited". A character only a proposed candidate offers
 * is "candidate": it is not in the face until the candidate is accepted.
 */
export const classifyFace = (face: FaceCharacters): FaceClassification => {
  const proposed = new Set(
    face.candidates.flatMap((candidate) => candidate.characters)
  );
  const classify: Classifier = (codePoint) => {
    if (face.working.characters.has(codePoint)) {
      return "added";
    }
    if (includes(face.source, codePoint)) {
      const glyphId = face.glyphForCharacter(codePoint);
      return glyphId !== undefined && face.working.overrides.has(glyphId)
        ? "edited"
        : "source";
    }
    return proposed.has(codePoint) ? "candidate" : "missing";
  };
  const characters = Uint32Array.from(
    new Set([...face.source, ...face.working.characters.keys(), ...proposed])
  ).sort();
  return { characters, classify };
};

/** The coverage of one script or shared group a face touches. */
export interface ScopeCoverage extends CoverageSummary {
  readonly name: string;
  readonly scope: Scope;
}

const keyOf = (scope: Scope) => {
  if (scope.kind === "script") {
    return `script:${scope.code}`;
  }
  return scope.kind === "shared" ? `shared:${scope.group}` : "";
};

/**
 * A summary of every script and shared group a face touches, the best covered
 * first. Characters with no script, such as private use, are left out.
 */
export const coverageByScript = (face: FaceClassification): ScopeCoverage[] => {
  const touched = new Map<string, Scope>();
  for (const codePoint of face.characters) {
    const scope = scopeOf(codePoint);
    if (scope) {
      touched.set(keyOf(scope), scope);
    }
  }
  return [...touched.values()]
    .map((scope): ScopeCoverage => {
      const counts = emptyCounts();
      const characters = charactersIn(scope);
      for (const codePoint of characters) {
        counts[face.classify(codePoint)] += 1;
      }
      return {
        ...summarise(counts, characters.length),
        name: scopeName(scope),
        scope,
      };
    })
    .sort(
      (a, b) => b.covered - a.covered || a.name.localeCompare(b.name, "en")
    );
};
