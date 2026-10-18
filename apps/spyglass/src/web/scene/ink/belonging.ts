import { dashAt, inkStyle } from "../../ladder/ink-ladder";
import type { BelongingLayer, BelongingRegion } from "../../layout/belonging";
import { compositionInsideLand } from "../../layout/composition-placement";
import type { ResponsibilityOverlay } from "../../layout/responsibility-focus";
import { paintNaturalFeatures } from "../paint-features";
import type { InkState } from "./state";
import { trace } from "./trace";

/** District and responsibility pigment, and the natural features, on the island they belong to. */
export function paintBelonging(state: InkState): void {
  paintBelongingInk(
    state.belonging,
    state.regionStrength,
    state.ctx,
    state.responsibility,
    state.baselineRegionId,
    state.pixels,
    state.matches,
    state.activeRegion,
    state.detail,
    state.streams
  );
}

/** Landmarks and marsh stay through file zoom; they recede only under composition. */
function featureStrength(
  belonging: BelongingLayer,
  detail: { composition: number; districts: number; files: number }
) {
  return (
    Math.min(1, detail.districts + detail.files) *
    (1 - detail.composition * 0.8) *
    (belonging.reveal ?? 1)
  );
}

function paintBelongingInk(
  belonging: BelongingLayer | null,
  regionStrength: number,
  ctx: CanvasRenderingContext2D,
  responsibility: ResponsibilityOverlay | null,
  baselineRegionId: string | undefined,
  pixels: number,
  matches: BelongingRegion | undefined,
  activeRegion: BelongingRegion | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  streams: boolean
) {
  if (!belonging) {
    return;
  }
  const features = belonging.features ? featureStrength(belonging, detail) : 0;
  if (regionStrength <= 0 && features <= 0) {
    return;
  }
  ctx.save();
  ctx.translate(belonging.territory.x, belonging.territory.y);
  trace(ctx, belonging.territory.coast);
  ctx.clip("evenodd");
  const enclosing = belonging.parents?.find(
    (region) => region.children && !region.collection
  );
  if (regionStrength > 0) {
    paintParents(
      belonging,
      ctx,
      enclosing,
      responsibility,
      baselineRegionId,
      regionStrength,
      pixels
    );
    paintRegions(
      belonging,
      ctx,
      enclosing,
      matches,
      activeRegion,
      responsibility,
      baselineRegionId,
      detail,
      regionStrength,
      pixels
    );
  }
  if (belonging.features && features > 0) {
    paintNaturalFeatures(ctx, belonging.features, {
      focus: belonging.featureFocus,
      pixels,
      streams,
      strength: features,
    });
  }
  if (enclosing && regionStrength > 0) {
    ctx.fillStyle = enclosing.color;
    ctx.globalAlpha = 0.65 * regionStrength;
    const members =
      belonging.files ?? belonging.regions.flatMap((region) => region.members);
    for (const file of members) {
      if (compositionInsideLand(file.x, file.y, enclosing.polygons)) {
        continue;
      }
      ctx.fillRect(
        file.x - 1.5 / pixels,
        file.y - 1.5 / pixels,
        3 / pixels,
        3 / pixels
      );
    }
  }
  ctx.restore();
}

function paintRegions(
  belonging: BelongingLayer,
  ctx: CanvasRenderingContext2D,
  enclosing: BelongingRegion | undefined,
  matches: BelongingRegion | undefined,
  activeRegion: BelongingRegion | undefined,
  responsibility: ResponsibilityOverlay | null,
  baselineRegionId: string | undefined,
  detail: {
    composition: number;
    districts: number;
    files: number;
    specks: number;
  },
  regionStrength: number,
  pixels: number
) {
  for (const region of belonging.regions) {
    ctx.save();
    if (enclosing && region !== matches) {
      trace(ctx, enclosing.polygons);
      ctx.clip("evenodd");
    }
    const active = region === activeRegion;
    const retained = responsibility?.trace && region.id === baselineRegionId;
    trace(ctx, region.polygons);
    ctx.strokeStyle = region.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha =
      regionFillAlpha(retained, active, belonging, region) *
      (retained ? 1 : (1 - detail.composition) * (belonging.reveal ?? 1)) *
      regionStrength;
    ctx.fill("evenodd");
    ctx.globalAlpha =
      regionOutlineAlpha(retained, active, belonging, region, pixels) *
      (retained ? 1 : (1 - detail.composition) * (belonging.reveal ?? 1)) *
      regionStrength;
    ctx.lineWidth = (active ? 1.5 : 0.7) / pixels;
    ctx.setLineDash(
      region.uncertain ? dashAt(inkStyle("unresolved-outline"), pixels) : []
    );
    ctx.stroke();
    ctx.restore();
  }
}

function paintParents(
  belonging: BelongingLayer,
  ctx: CanvasRenderingContext2D,
  enclosing: BelongingRegion | undefined,
  responsibility: ResponsibilityOverlay | null,
  baselineRegionId: string | undefined,
  regionStrength: number,
  pixels: number
) {
  for (const parent of [
    ...(belonging.surroundings ?? []),
    ...(belonging.parents ?? []),
  ]) {
    if (parent.collection) {
      continue;
    }
    const passive = belonging.surroundings?.includes(parent);
    ctx.save();
    if (!parent.children && enclosing) {
      trace(ctx, enclosing.polygons);
      ctx.clip("evenodd");
    }
    trace(ctx, parent.polygons);
    ctx.strokeStyle = parent.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.globalAlpha =
      parentFillAlpha(responsibility, parent, baselineRegionId, passive) *
      regionStrength;
    ctx.fill("evenodd");
    ctx.globalAlpha = (passive ? 0.2 : 0.45) * regionStrength;
    ctx.lineWidth = 1 / pixels;
    // An entered responsibility's long dash keeps it apart from unresolved belonging.
    ctx.setLineDash(
      parent.children ? [] : dashAt(inkStyle("entered-outline"), pixels)
    );
    ctx.stroke();
    if (parent.anchor) {
      ctx.globalAlpha = (passive ? 0.35 : 0.85) * regionStrength;
      ctx.setLineDash([]);
      const size = 4 / pixels;
      ctx.strokeRect(
        parent.anchor.x - size,
        parent.anchor.y - size,
        size * 2,
        size * 2
      );
    }
    ctx.restore();
  }
}

function regionOutlineAlpha(
  retained: boolean | undefined,
  active: boolean,
  belonging: BelongingLayer,
  region: BelongingRegion,
  pixels: number
): number {
  if (retained) {
    return 0.2;
  }
  if (active) {
    return 0.3 + 0.55 * (belonging.emphasis ?? 1);
  }
  if (region.uncertain) {
    return Math.min(0.3, pixels / 30);
  }
  return 0.3;
}

function regionFillAlpha(
  retained: boolean | undefined,
  active: boolean,
  belonging: BelongingLayer,
  region: BelongingRegion
): number {
  if (retained) {
    return 0.12;
  }
  if (active) {
    return 0.14 + 0.16 * (belonging.emphasis ?? 1);
  }
  if (region.uncertain) {
    return 0.045;
  }
  return 0.14;
}

function parentFillAlpha(
  responsibility: ResponsibilityOverlay | null,
  parent: BelongingRegion,
  baselineRegionId: string | undefined,
  passive: boolean | undefined
): 0.12 | 0.025 | 0.075 {
  if (responsibility?.trace && parent.id === baselineRegionId) {
    return 0.12;
  }
  if (passive) {
    return 0.025;
  }
  return 0.075;
}
