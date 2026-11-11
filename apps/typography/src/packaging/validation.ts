/**
 * Validates a derived font from several independent directions and reports
 * each one in plain words. The engine built the font, so its own check is
 * only the first of five.
 */

import { reasonOf } from "~/lib/reason";
import type { FontReader, OpenFace } from "~/typeface/reading";
import type { BuildRequest, FontBuilder } from "./building";
import { listCharacters } from "./character-selection";
import { isWoff2, unpackWoff2 } from "./container";
import {
  checkSample,
  type SampleResult,
  type ShapingSample,
} from "./shaping-retention";

export type DerivedFontCheckId =
  | "engine"
  | "reopen"
  | "coverage"
  | "shaping"
  | "joining"
  | "browser";

export interface DerivedFontCheck {
  /** One line per finding or per sample text. */
  readonly details: readonly string[];
  readonly id: DerivedFontCheckId;
  readonly message: string;
  /** A check that could not run, or had nothing to run on, is not-run. */
  readonly outcome: "pass" | "fail" | "not-run";
}

export interface DerivedFontReport {
  readonly checks: readonly DerivedFontCheck[];
  /** True when no check failed. */
  readonly passed: boolean;
}

export interface DerivedFontValidation {
  /** Rejects when the browser will not load the font. See `loadInBrowser`. */
  readonly browserCheck?: (font: Uint8Array) => Promise<unknown>;
  readonly builder: FontBuilder;
  /** The built file, in either format. */
  readonly derived: Uint8Array;
  readonly reader: FontReader;
  /** The request the font was built from. It names the source and what was kept. */
  readonly request: BuildRequest;
  /** Texts that exercise the shaping the font has to keep. */
  readonly samples: readonly ShapingSample[];
}

const LISTED_CHARACTERS = 8;

const check = (
  id: DerivedFontCheckId,
  outcome: DerivedFontCheck["outcome"],
  message: string,
  details: readonly string[] = []
): DerivedFontCheck => ({ details, id, message, outcome });

const checkEngine = async (
  builder: FontBuilder,
  derived: Uint8Array
): Promise<DerivedFontCheck> => {
  const report = await builder.validate(derived);
  const details = report.issues.map((issue) => issue.message);
  return report.loadable
    ? check(
        "engine",
        "pass",
        "The font engine reads every table and saves the font again without errors.",
        details
      )
    : check(
        "engine",
        "fail",
        "The font engine found errors in the font.",
        details
      );
};

const checkCoverage = (
  source: OpenFace,
  derived: OpenFace,
  request: BuildRequest
): DerivedFontCheck => {
  const expected = [
    ...new Set(
      request.subset?.characters ?? [
        ...source.characters(),
        ...request.added.flatMap((glyph) => glyph.characters),
      ]
    ),
  ];
  const missing = expected.filter(
    (character) => derived.glyphForCharacter(character) === undefined
  );
  if (missing.length === 0) {
    return check(
      "coverage",
      "pass",
      `All ${expected.length} requested characters are in the font.`
    );
  }
  return check(
    "coverage",
    "fail",
    `${missing.length} of the ${expected.length} requested characters are not in the font.`,
    [`Missing: ${listCharacters(missing, LISTED_CHARACTERS)}.`]
  );
};

const checkShaping = (results: readonly SampleResult[]): DerivedFontCheck => {
  const details = results.map((result) => result.detail);
  const checked = results.filter((result) => result.verdict !== "not-checked");
  if (checked.length === 0) {
    return check(
      "shaping",
      "not-run",
      "No sample text could be shaped. Supply texts that use the characters the font keeps.",
      details
    );
  }
  const different = checked.filter((result) => result.verdict === "different");
  return different.length === 0
    ? check(
        "shaping",
        "pass",
        `All ${checked.length} sample texts shape as they should.`,
        details
      )
    : check(
        "shaping",
        "fail",
        `${different.length} of ${checked.length} sample texts shape differently from the source.`,
        details
      );
};

/** Ligatures and conjuncts: only texts the source really joins can prove anything. */
const checkJoining = (results: readonly SampleResult[]): DerivedFontCheck => {
  const joining = results.filter((result) => result.joins);
  if (joining.length === 0) {
    return check(
      "joining",
      "not-run",
      "No sample text forms a ligature or conjunct in the source with the kept features, so this was not exercised."
    );
  }
  const details = joining.map((result) => result.detail);
  const lost = joining.filter((result) => result.verdict === "different");
  return lost.length === 0
    ? check(
        "joining",
        "pass",
        `The font still forms the ligatures and conjuncts of all ${joining.length} sample texts that have them.`,
        details
      )
    : check(
        "joining",
        "fail",
        `${lost.length} of ${joining.length} sample texts lost a ligature or conjunct whose feature was kept.`,
        details
      );
};

const SKIPPED = "Not run, because the font did not reopen.";

/** A check that throws has failed. It must not take the other checks with it. */
const attempt = (
  id: DerivedFontCheckId,
  run: () => DerivedFontCheck
): DerivedFontCheck => {
  try {
    return run();
  } catch (error) {
    return check(id, "fail", `This check could not finish: ${reasonOf(error)}`);
  }
};

const checkAgainstSource = (
  reopened: OpenFace,
  { reader, request, samples }: DerivedFontValidation
): DerivedFontCheck[] => {
  let source: OpenFace;
  try {
    source = reader.open(request.source, request.faceIndex);
  } catch (error) {
    const message = `Not run, because the source font does not open: ${reasonOf(error)}`;
    return [
      check("coverage", "fail", message),
      check("shaping", "fail", message),
      check("joining", "fail", message),
    ];
  }
  try {
    let results: SampleResult[] = [];
    const shaping = attempt("shaping", () => {
      results = samples.map((sample) =>
        checkSample(source, reopened, request, sample)
      );
      return checkShaping(results);
    });
    return [
      attempt("coverage", () => checkCoverage(source, reopened, request)),
      shaping,
      shaping.outcome === "fail" && results.length === 0
        ? check(
            "joining",
            "not-run",
            "Not run, because shaping could not be checked."
          )
        : checkJoining(results),
    ];
  } finally {
    source.close();
  }
};

/** Reopens the font with the reader and runs the checks that need it open. */
const checkReopened = async (
  input: DerivedFontValidation
): Promise<DerivedFontCheck[]> => {
  const { builder, derived, reader } = input;
  const packed = isWoff2(derived);
  let reopened: OpenFace;
  try {
    reopened = reader.open(
      packed ? await unpackWoff2(builder, derived) : derived
    );
  } catch (error) {
    return [
      check("reopen", "fail", `The font does not reopen: ${reasonOf(error)}`),
      check("coverage", "not-run", SKIPPED),
      check("shaping", "not-run", SKIPPED),
      check("joining", "not-run", SKIPPED),
    ];
  }
  try {
    const { characterCount, familyName, glyphCount } = reopened.description;
    return [
      check(
        "reopen",
        "pass",
        `The font reopens${packed ? " after unpacking" : ""} as ${familyName}, with ${glyphCount} glyphs and ${characterCount} characters.`
      ),
      ...checkAgainstSource(reopened, input),
    ];
  } finally {
    reopened.close();
  }
};

const checkBrowser = async (
  input: DerivedFontValidation
): Promise<DerivedFontCheck> => {
  if (!input.browserCheck) {
    return check("browser", "not-run", "No browser check was supplied.");
  }
  try {
    await input.browserCheck(input.derived);
    return check("browser", "pass", "The browser loads the font.");
  } catch (error) {
    return check(
      "browser",
      "fail",
      `The browser does not load the font: ${reasonOf(error)}`
    );
  }
};

export const validateDerivedFont = async (
  input: DerivedFontValidation
): Promise<DerivedFontReport> => {
  const engine = await checkEngine(input.builder, input.derived).catch(
    (error: unknown) =>
      check(
        "engine",
        "fail",
        `The font engine could not check the font: ${reasonOf(error)}`
      )
  );
  const checks = [
    engine,
    ...(await checkReopened(input)),
    await checkBrowser(input),
  ];
  return {
    checks,
    passed: checks.every((result) => result.outcome !== "fail"),
  };
};
