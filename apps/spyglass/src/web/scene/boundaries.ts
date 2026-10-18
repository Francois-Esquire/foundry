import { developerInks } from "../ladder/ink-ladder";
import type { BoundaryLayers } from "../layout/boundaries";
import type {
  BoundaryId,
  BoundaryVisibility,
} from "../settings/boundary-settings";
import { traceArchipelago } from "./archipelago-ink";

interface BoundaryStyle {
  color: string;
  dash: number[];
  description: string;
  label: string;
}

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
    description: "Original island geometry",
    label: "Coastlines",
  },
  footprint: {
    color: developerInks.boundaries.footprint,
    dash: [],
    description: "Concave envelope · placement boundary",
    label: "Landmass outlines",
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
    description: "All packages · outer envelope",
    label: "Spyglass hull",
  },
  pockets: {
    color: developerInks.boundaries.pockets,
    dash: [7, 3, 1, 3],
    description: "Ocean-accessible space inside each hull",
    label: "Coastal pockets",
  },
} satisfies Record<BoundaryId, BoundaryStyle>;

export function paintBoundaries(
  ctx: CanvasRenderingContext2D,
  layers: BoundaryLayers,
  visible: BoundaryVisibility,
  pixels: number
) {
  ctx.save();
  ctx.lineWidth = Math.max(0.65, 1 / pixels);
  ctx.globalAlpha = 0.8;
  for (const key of Object.keys(boundaryStyles) as BoundaryId[]) {
    if (!visible[key]) {
      continue;
    }
    const style = boundaryStyles[key];
    ctx.strokeStyle = style.color;
    ctx.setLineDash(style.dash.map((d) => d / Math.max(0.8, pixels)));
    for (const ring of layers[key]) {
      traceArchipelago(ctx, ring);
      ctx.stroke();
    }
  }
  ctx.restore();
}
