/**
 * Style consistency: does a glyph look like it belongs to the face. Each
 * check is a measured value, the value the style reference expects, and a
 * tolerance.
 */
import type { GlyphDraft } from "../draft";
import type { HeightZone } from "../normalise/height-model";
import {
  dominantLength,
  edgeShapes,
  type InkMeasure,
  measureInk,
  measureResolution,
} from "../style/measure";
import { inkDensityOf, type StyleReference } from "../style/reference";
import type { Defect, StyleCheck } from "./evaluation";

export interface StyleFindings {
  readonly checks: readonly StyleCheck[];
  readonly defects: readonly Defect[];
}

/** Stems may differ from the face's by this share before they read as another weight. */
const STEM_TOLERANCE = 0.2;
/** A glyph needs this many rows or columns through a stroke before its thickness means anything. */
const ENOUGH_RUNS = 12;
/** Sidebearings may differ from the face's model by this share of the em. */
const BEARING_TOLERANCE = 0.1;
/** Ink density may leave the face's usual range by this share of it. */
const DENSITY_SLACK = 0.25;

const check = (
  name: string,
  measured: number,
  expected: number,
  tolerance: number
): StyleCheck => ({
  expected,
  measured,
  name,
  pass: Math.abs(measured - expected) <= tolerance,
  tolerance,
});

/** How close ink must come to a line to count as reaching it. */
const lineTolerance = (style: StyleReference) =>
  Math.max(2 * style.overshoot, 0.02 * style.unitsPerEm);

/**
 * Upright stem thickness: the commonest width of ink crossed along the rows.
 * Thickness measured down the columns is not checked per glyph, because a
 * letter made of diagonals has no level stroke to measure.
 */
const stemChecks = (ink: InkMeasure, style: StyleReference): StyleCheck[] => {
  const upright = dominantLength(
    ink.horizontalRuns,
    measureResolution(style.unitsPerEm)
  );
  return upright !== undefined && ink.horizontalRuns.length >= ENOUGH_RUNS
    ? [
        check(
          "stem thickness",
          upright,
          style.stems.vertical,
          STEM_TOLERANCE * style.stems.vertical
        ),
      ]
    : [];
};

const heightChecks = (
  ink: InkMeasure,
  zone: HeightZone | undefined,
  style: StyleReference
): StyleCheck[] => {
  const tolerance = lineTolerance(style);
  const checks: StyleCheck[] = [];
  if (zone?.top !== undefined) {
    checks.push(
      check(`top of a ${zone.name}`, ink.bounds.yMax, zone.top, tolerance)
    );
  }
  if (zone?.bottom !== undefined) {
    checks.push(
      check(`foot of a ${zone.name}`, ink.bounds.yMin, zone.bottom, tolerance)
    );
  }
  return checks;
};

const spacingChecks = (
  draft: GlyphDraft,
  ink: InkMeasure,
  style: StyleReference
): StyleCheck[] => {
  const edges = edgeShapes(draft.outline, style.slant);
  if (!edges) {
    return [];
  }
  const tolerance = BEARING_TOLERANCE * style.unitsPerEm;
  return [
    check(
      `left sidebearing beside a ${edges.left} edge`,
      ink.bounds.xMin,
      style.sidebearings[edges.left],
      tolerance
    ),
    check(
      `right sidebearing beside a ${edges.right} edge`,
      draft.advance - ink.bounds.xMax,
      style.sidebearings[edges.right],
      tolerance
    ),
  ];
};

const densityCheck = (
  draft: GlyphDraft,
  ink: InkMeasure,
  style: StyleReference
): StyleCheck => {
  const { high, low } = style.inkDensity;
  const centre = (high + low) / 2;
  return check(
    "ink density",
    inkDensityOf(ink, draft.advance),
    centre,
    ((high - low) / 2) * (1 + DENSITY_SLACK) + DENSITY_SLACK * centre
  );
};

const describe = ({ expected, measured, name, tolerance }: StyleCheck) =>
  `The ${name} measures ${Number(measured.toFixed(3))} against ${Number(expected.toFixed(3))} in the face, more than the ${Number(tolerance.toFixed(3))} allowed.`;

const defectFor = (failed: StyleCheck): Defect => {
  if (failed.name.includes("sidebearing")) {
    return { correction: "respace", detail: describe(failed), kind: "spacing" };
  }
  if (failed.name.startsWith("top of") || failed.name.startsWith("foot of")) {
    return {
      correction: "refit-heights",
      detail: describe(failed),
      kind: "heights",
    };
  }
  return {
    detail: describe(failed),
    kind: failed.name === "ink density" ? "ink-density" : "stem-thickness",
  };
};

export const checkStyle = (
  draft: GlyphDraft,
  style: StyleReference,
  zone: HeightZone | undefined
): StyleFindings => {
  const ink = measureInk(draft.outline, style.unitsPerEm);
  if (!ink) {
    return { checks: [], defects: [] };
  }
  // Stems and density describe letters. A glyph the height model gives no
  // line to, such as a full stop, has dots and strokes of its own weight.
  const lettered = zone?.top !== undefined || zone?.bottom !== undefined;
  const checks = [
    ...(lettered ? stemChecks(ink, style) : []),
    ...heightChecks(ink, zone, style),
    ...spacingChecks(draft, ink, style),
    ...(lettered ? [densityCheck(draft, ink, style)] : []),
  ];
  return {
    checks,
    defects: checks.filter((item) => !item.pass).map(defectFor),
  };
};
