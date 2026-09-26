import { archipelagoHull, traceArchipelago } from "./archipelago";
import { landmassFootprint } from "./landmass-footprint";
import { landmassHull, packageGroups } from "./landmasses";
import type { AtlasData } from "./types";

export const boundaryStyles = {
  clearance: {
    color: "#866279",
    dash: [2, 4],
    description: "32-unit padded package hulls",
    label: "Package clearance",
  },
  coasts: {
    color: "#555e42",
    dash: [],
    description: "Original island geometry",
    label: "Coastlines",
  },
  footprint: {
    color: "#3f716b",
    dash: [],
    description: "Concave envelope · placement boundary",
    label: "Landmass outlines",
  },
  groups: {
    color: "#766549",
    dash: [3, 5],
    description: "Connected groups · convex bounds",
    label: "Group hulls",
  },
  outer: {
    color: "#596f68",
    dash: [5, 7],
    description: "All packages · outer envelope",
    label: "Atlas hull",
  },
  pockets: {
    color: "#a06438",
    dash: [7, 3, 1, 3],
    description: "Ocean-accessible space inside each hull",
    label: "Coastal pockets",
  },
};

export type BoundaryId = keyof typeof boundaryStyles;
export type BoundaryVisibility = Record<BoundaryId, boolean>;
export const defaultBoundaries: BoundaryVisibility = {
  clearance: false,
  coasts: false,
  footprint: false,
  groups: false,
  outer: false,
  pockets: false,
};

export function atlasBoundaries(
  data: AtlasData,
  coastalBuffer = 32,
  suppliedFootprints?: ReturnType<typeof landmassFootprint>[]
): Record<BoundaryId, [number, number][][]> {
  const groups = packageGroups(
    data.territories,
    data.routes,
    data.declaredDependencies
  ).filter((g) => g.length > 1);
  const footprints =
    suppliedFootprints ??
    groups.map((group) => landmassFootprint(group, coastalBuffer));
  return {
    clearance: data.territories.map((p) => landmassHull([p])),
    coasts: data.territories.flatMap((p) =>
      p.coast.flatMap((polygon) =>
        polygon.map((ring) =>
          ring.map(([x, y]): [number, number] => [x + p.x, y + p.y])
        )
      )
    ),
    footprint: footprints.flatMap((f) => f.outline),
    groups: groups.map((g) => landmassHull(g)),
    outer: [archipelagoHull(data)],
    pockets: footprints.flatMap((f) => f.pocketRings),
  };
}

export function paintBoundaries(
  ctx: CanvasRenderingContext2D,
  layers: ReturnType<typeof atlasBoundaries>,
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
