import { inkAlpha, inks } from "../ladder/ink-ladder";
import { detailLevel } from "../view/detail-level";
import type { MarkAlpha, Stroke } from "./marks";
import { internAlpha, ringPoints } from "./marks";
import type { ContourLine } from "./topography";

/** A contour's width in CSS pixels: the emphasised lines and the rest. */
const contourWidth = { major: 0.7, minor: 0.45 } as const;

/** Minor contours surface between these zooms, in pixels per unit; the major ones are always drawn. */
const minorFade = { from: 1.1, over: 1.2 } as const;

/** Contour ink sits on the ladder: land contours on the relief rung, sea rings on the sea rung. */
function contourAlpha(line: ContourLine): number {
  if (line.sea) {
    return line.major ? inkAlpha.seaContourMajor : inkAlpha.seaContourMinor;
  }
  return line.major ? inkAlpha.landContourMajor : inkAlpha.landContourMinor;
}

const contourPoints = new WeakMap<ContourLine, number[]>();

/** A contour's points as one polyline, kept by the line so a rebuild keeps its draping. */
function pointsOf(line: ContourLine): number[] {
  let points = contourPoints.get(line);
  if (!points) {
    points = ringPoints(line.points);
    contourPoints.set(line, points);
  }
  return points;
}

/**
 * The contours as strokes: each land contour draped on its island, each sea
 * ring flat on the water, in the ladder's contour inks. Every strength that
 * follows the zoom is an alpha function: the veil that lifts the contours
 * while a composition is drawn, the fade that brings the minor lines in
 * past overview, the ring's own opacity and the ladder's alpha, folded into
 * one function per distinct product, so the layer is static geometry built
 * once per set of contours and whether a composition is shown. Nothing is
 * thinned or cut around names: the fade thins the minor lines at overview
 * and the names' halos cover the lines beneath them.
 */
export function topographyMarks(
  lines: readonly ContourLine[],
  hasComposition: boolean
): Stroke[] {
  const share = internAlpha();
  const alphaFor = (line: ContourLine): MarkAlpha => {
    const key = `${line.major ? "major" : "minor"}|${line.sea ? "sea" : "land"}|${line.opacity}`;
    return share(key, () => {
      const strength = line.opacity * contourAlpha(line);
      const { major } = line;
      return (pixels: number) => {
        const veil = 1 - detailLevel(pixels, hasComposition).composition * 0.8;
        const detail = major
          ? 1
          : Math.max(
              0,
              Math.min(1, (pixels - minorFade.from) / minorFade.over)
            );
        return veil * detail * strength;
      };
    });
  };
  const marks: Stroke[] = [];
  for (const line of lines) {
    marks.push({
      alpha: alphaFor(line),
      colour: line.sea ? inks.seaContour : inks.landContour,
      kind: "stroke",
      on: line.on,
      points: pointsOf(line),
      width: line.major ? contourWidth.major : contourWidth.minor,
    });
  }
  return marks;
}
