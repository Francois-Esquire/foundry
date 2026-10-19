import { developerInks } from "../ladder/ink-ladder";
import type {
  BoundaryId,
  BoundaryVisibility,
} from "../settings/boundary-settings";
import { flattenArchipelago } from "./archipelago";
import type { BoundaryLayers } from "./boundaries";
import type { Stroke, StrokeDash } from "./marks";
import { dashOf } from "./marks";

interface BoundaryStyle {
  color: string;
  dash: readonly number[];
  description: string;
  label: string;
}

/** How each boundary outline is drawn and named, for the developer's controls and the marks alike. */
export const boundaryStyles = {
  clearance: {
    color: developerInks.boundaries.clearance,
    dash: [2, 4],
    description: "32-unit padded package hulls",
    label: "Package clearance",
  },
  coasts: {
    color: developerInks.boundaries.coasts,
    dash: [],
    description: "Island shorelines · water level",
    label: "Coastlines",
  },
  depths: {
    color: developerInks.boundaries.depths,
    dash: [1, 3],
    description: "Terrain elevation contours, abyss to shelf",
    label: "Depth contours",
  },
  footprint: {
    color: developerInks.boundaries.footprint,
    dash: [],
    description: "Concave envelope · placement boundary",
    label: "Landmass outlines",
  },
  foundations: {
    color: developerInks.boundaries.foundations,
    dash: [4, 3],
    description: "Each shared group and internal foundation, overlaps kept",
    label: "Foundation boundaries",
  },
  groups: {
    color: developerInks.boundaries.groups,
    dash: [3, 5],
    description: "Connected groups · convex bounds",
    label: "Group hulls",
  },
  outer: {
    color: developerInks.boundaries.outer,
    dash: [5, 7],
    description: "Terrain silhouette · open-sea falloff",
    label: "Outer silhouette",
  },
  pockets: {
    color: developerInks.boundaries.pockets,
    dash: [7, 3, 1, 3],
    description: "Ocean-accessible space inside each hull",
    label: "Coastal pockets",
  },
} satisfies Record<BoundaryId, BoundaryStyle>;

/** An outline's pen, in CSS pixels, and how faint it is drawn. */
const boundaryPen = 1;
const boundaryAlpha = 0.8;
/** Units between the points an outline's curve is flattened to. */
const curveSpacing = 4;

type Ring = [number, number][];

const outlines = new WeakMap<Ring, number[]>();

/** A boundary's smoothed outline as a closed polyline, kept by the ring so a toggle keeps its vertices. */
function outlineOf(ring: Ring): number[] {
  let points = outlines.get(ring);
  if (!points) {
    const flat = flattenArchipelago(ring, curveSpacing);
    const [first] = flat;
    points = [...flat, ...(first ? [first] : [])].flat();
    outlines.set(ring, points);
  }
  return points;
}

/**
 * The layout's outlines a developer turned on, each boundary in its own ink
 * and dash, flat on the sea at a fine pen. Built once per set of outlines
 * and visibility; nothing while every boundary is off.
 */
export function boundaryMarks(
  layers: BoundaryLayers,
  visible: BoundaryVisibility
): Stroke[] {
  const marks: Stroke[] = [];
  for (const key of Object.keys(boundaryStyles) as BoundaryId[]) {
    if (!visible[key]) {
      continue;
    }
    const style = boundaryStyles[key];
    const dash: StrokeDash | undefined = dashOf(style);
    for (const ring of layers[key]) {
      marks.push({
        alpha: boundaryAlpha,
        colour: style.color,
        dash,
        kind: "stroke",
        points: outlineOf(ring),
        width: boundaryPen,
      });
    }
  }
  return marks;
}
