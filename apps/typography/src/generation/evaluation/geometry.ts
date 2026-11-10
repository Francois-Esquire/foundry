/** Geometry checks: is the outline a sound, fillable shape that fits the face's metrics. */
import {
  type Contour,
  type Outline,
  outlineBounds,
  outlinePoints,
} from "~/typeface/outline";
import { debrisArea } from "../normalise/clean";
import type { HeightZone } from "../normalise/height-model";
import { flattenContour, signedArea } from "../raster/flatten";
import type { StyleReference } from "../style/reference";
import { nestingOf, runsCorrectly } from "../vector/direction";
import type { Defect } from "./evaluation";

export interface GeometryFindings {
  /** How many checks ran. */
  readonly checks: number;
  readonly defects: readonly Defect[];
}

/**
 * More points than this per contour, on average, means a trace that was not
 * simplified. The most complex drawn glyphs, such as a quadratic S, stay near 100.
 */
const POINTS_PER_CONTOUR = 150;
const CLOSING_SLACK = 0.5;

const hasFinitePoints = (outline: Outline) =>
  outlinePoints(outline).every(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
  );

const closingGap = (contour: Contour): number => {
  const last = contour.segments.at(-1)?.to ?? contour.start;
  return Math.hypot(last.x - contour.start.x, last.y - contour.start.y);
};

const directionDefect = (outline: Outline): Defect[] => {
  const nesting = nestingOf(outline);
  const right = nesting.filter(runsCorrectly).length;
  // Either convention is sound, as long as every contour follows the same one.
  return right === 0 || right === nesting.length
    ? []
    : [
        {
          correction: "fix-direction",
          detail: `${nesting.length - right} of ${nesting.length} contours run against the others, so a counter would fill in or a shape would cut a hole.`,
          kind: "direction",
        },
      ];
};

const metricsDefect = (
  outline: Outline,
  style: StyleReference,
  zone: HeightZone | undefined
): Defect[] => {
  const bounds = outlineBounds(outline);
  if (!bounds) {
    return [];
  }
  const { bottom, top } = style.extent;
  if (bounds.yMax <= top && bounds.yMin >= bottom) {
    return [];
  }
  const hasLine = zone?.top !== undefined || zone?.bottom !== undefined;
  return [
    {
      correction: hasLine ? "refit-heights" : undefined,
      detail: `The ink runs from ${Math.round(bounds.yMin)} to ${Math.round(bounds.yMax)}, outside the face's ${Math.round(bottom)} to ${Math.round(top)}.`,
      kind: "outside-metrics",
    },
  ];
};

/** Checks that stop at the first fatal problem: nothing else can be measured on such an outline. */
const fatalDefect = (outline: Outline): Defect | undefined => {
  if (outline.contours.length === 0) {
    return { detail: "The outline has no contours.", kind: "empty" };
  }
  if (!hasFinitePoints(outline)) {
    return {
      detail: "The outline has coordinates that are not numbers.",
      kind: "not-finite",
    };
  }
};

export const checkGeometry = (
  outline: Outline,
  style: StyleReference,
  zone: HeightZone | undefined
): GeometryFindings => {
  const checks = 6;
  const fatal = fatalDefect(outline);
  if (fatal) {
    return { checks, defects: [fatal] };
  }
  const defects: Defect[] = [];
  const open = outline.contours.filter(
    (contour) => closingGap(contour) > CLOSING_SLACK
  ).length;
  if (open > 0) {
    defects.push({
      correction: "close-contours",
      detail: `${open} contour(s) stop short of their start and rely on an implied closing line.`,
      kind: "open-contour",
    });
  }
  const smallest = debrisArea(style.stems.vertical, style.unitsPerEm);
  const debris = outline.contours.filter(
    (contour) =>
      contour.segments.length < 2 ||
      Math.abs(signedArea(flattenContour(contour, 1))) < smallest
  ).length;
  if (debris > 0) {
    defects.push({
      correction: "remove-debris",
      detail: `${debris} contour(s) enclose less than ${Math.round(smallest)} square units: too small to be drawn on purpose.`,
      kind: "debris",
    });
  }
  const points = outlinePoints(outline).length;
  if (points > POINTS_PER_CONTOUR * outline.contours.length) {
    defects.push({
      detail: `${points} points on ${outline.contours.length} contour(s) is more than a drawn glyph needs, and makes it hard to edit.`,
      kind: "point-count",
    });
  }
  defects.push(
    ...directionDefect(outline),
    ...metricsDefect(outline, style, zone)
  );
  return { checks, defects };
};
