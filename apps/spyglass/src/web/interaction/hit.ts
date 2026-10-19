import type { Vector3 } from "three";
import type { SpyglassData, SpyglassFile, Territory } from "../data/types";
import type { BelongingLayer } from "../layout/belonging";
import { hitBelonging } from "../layout/belonging";
import type { BelongingView } from "../layout/belonging-view";
import { labelPlaneHeight, type MapLabel } from "../layout/labels";
import { hitNaturalFeature } from "../layout/natural-feature-inspection";
import { islandAt } from "../layout/polygons";
import type { ResponsibilityOverlay } from "../layout/responsibility-focus";
import {
  defaultSceneComposition,
  isSceneLayerVisible,
  type SceneComposition,
  type SceneLayerId,
} from "../settings/scene-composition";
import type { InkView } from "../view/chart-view";
import { detailLevel } from "../view/detail-level";
import { hitComposition } from "./composition-hit";
import type { SpyglassSelection } from "./selection";

/** What the repaint shows, as a hit test reads it. */
export interface HitContext {
  composition?: SceneComposition;
  /** The spyglass being drawn, with any territory relayout applied. */
  data: SpyglassData;
  /** The labels to hit before the land beneath them: the last repaint's, or this repaint's while it runs. */
  labels: readonly MapLabel[];
  pickBuilding?: (
    point: Vector3
  ) => (SpyglassSelection & { point: Vector3 }) | null;
  /** The terrain surface above a point on the paper, if land stands there. */
  pickTerrain: (point: Vector3) => Vector3 | undefined;
  reducedMotion: boolean;
  selectedFile?: string | null;
  /** The belonging layer and the overlay as the last repaint showed them: what is hit is what is drawn. */
  shown: Pick<
    BelongingView,
    "belonging" | "hasComposition" | "responsibility"
  > &
    Partial<Pick<BelongingView, "activeRegion">>;
  streams: boolean;
  view: InkView;
  visibility: { composition: boolean; files: boolean };
}

/**
 * The placed label under a point on the chart, which a click selects: one
 * with a place. The domain's name and a frame's label are captions, not
 * places, so a click passes through them.
 */
export function labelUnder(
  labels: readonly MapLabel[],
  x: number,
  y: number,
  view?: InkView
): MapLabel | undefined {
  return labels.find(
    (label) =>
      label.place &&
      Math.abs(x - label.x) < label.width / 2 &&
      y >= label.y - (view ? labelPlaneHeight(label, view) : label.height) &&
      y <= label.y
  );
}

/**
 * The place under a point on the paper plane: a label first, then a symbol
 * of a drawn composition, then a file, a natural feature or a region of the
 * island there, then the island itself. `point` is lifted to the terrain
 * surface when land stands there, so what reads it afterwards sees the hit.
 */
export function resolveHit(
  context: HitContext,
  point: Vector3
): SpyglassSelection | null {
  const place = visible(context, "labels")
    ? labelUnder(context.labels, point.x, -point.y, context.view)?.place
    : undefined;
  if (place) {
    return place;
  }
  const surface = context.pickTerrain(point);
  const building = visible(context, "architecture")
    ? context.pickBuilding?.(point)
    : null;
  if (building && (!surface || building.point.z >= surface.z)) {
    point.copy(building.point);
    return { file: building.file, territory: building.territory };
  }
  if (surface) {
    point.copy(surface);
  }
  const overlay = context.shown.responsibility;
  if (
    overlay &&
    context.visibility.composition &&
    visible(context, "responsibility")
  ) {
    const symbol = hitVisibleComposition(overlay, context, point);
    if (symbol) {
      return symbol;
    }
  }
  return hitLand(context, point);
}

function hitLand(
  context: HitContext,
  point: Vector3
): SpyglassSelection | null {
  const { data, shown, view } = context;
  const { belonging } = shown;
  const pixels = view.pixelsPerUnit;
  const level = detailLevel(pixels, shown.hasComposition);
  const closest = hitTerritory(context, point, pixels);
  if (closest?.file) {
    return closest;
  }
  const land = islandAt({ x: point.x, y: -point.y }, data.territories);
  const onBelonging =
    visible(context, "belonging") &&
    belonging &&
    land?.id === belonging.territory.id;
  if (onBelonging && level.composition < 0.5) {
    const internal = hitInternalPlace(
      belonging,
      { x: point.x - land.x, y: -point.y - land.y },
      pixels,
      context.streams
    );
    if (internal) {
      return internal;
    }
  }
  if (onBelonging) {
    return {
      compositeId: belonging.parents?.find((parent) => parent.children)?.id,
      regionId: belonging.parents?.find((parent) => !parent.children)?.id,
      territory: land,
    };
  }
  if (
    land &&
    (visible(context, "relief") ||
      visible(context, "cliffs") ||
      visible(context, "coast"))
  ) {
    return closest?.territory.id === land.id ? closest : { territory: land };
  }
  return null;
}

/** The nearest file within reach of the point, as the island it sits on; the file itself only when files are drawn and it is close. */
function hitTerritory(
  context: HitContext,
  point: Vector3,
  pixels: number
): SpyglassSelection | null {
  let closest: SpyglassSelection | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const territory of context.data.territories) {
    const x = point.x - territory.x;
    const y = -point.y - territory.y;
    for (const file of territory.files) {
      const d = Math.hypot(file.x - x, file.y - y);
      if (d < distance && d < 20 && fileVisible(context, territory, file)) {
        distance = d;
        closest = {
          territory,
          ...(d < Math.max(1, 5 / pixels) ? { file } : {}),
        };
      }
    }
  }
  return closest;
}

/** Only the marks that actually name this file grant it a hit target. */
function fileVisible(
  context: HitContext,
  territory: Territory,
  file: SpyglassFile
): boolean {
  if (visible(context, "files") && context.visibility.files) {
    return true;
  }
  if (visible(context, "file-focus") && context.selectedFile === file.id) {
    return true;
  }
  const { belonging, activeRegion, hasComposition } = context.shown;
  if (
    !visible(context, "file-members") ||
    belonging?.territory.id !== territory.id ||
    detailLevel(context.view.pixelsPerUnit, hasComposition).composition >= 0.5
  ) {
    return false;
  }
  const members =
    belonging.files ??
    (activeRegion && !activeRegion.children ? activeRegion.members : undefined);
  return members?.some((member) => member.id === file.id) ?? false;
}

function visible(context: HitContext, id: SceneLayerId): boolean {
  return isSceneLayerVisible(
    context.composition ?? defaultSceneComposition,
    id
  );
}

function hitVisibleComposition(
  overlay: ResponsibilityOverlay,
  context: HitContext,
  point: Vector3
): SpyglassSelection | null {
  const territory = context.data.territories.find(
    (item) => item.id === overlay.territoryId
  );
  if (!territory) {
    return null;
  }
  const detail = hitComposition(
    territory,
    { ...overlay, reducedMotion: context.reducedMotion },
    point.x - territory.x,
    -point.y - territory.y,
    context.view.pixelsPerUnit
  );
  return detail ? { territory, ...detail } : null;
}

function hitInternalPlace(
  belonging: BelongingLayer,
  point: { x: number; y: number },
  pixels: number,
  streams: boolean
): SpyglassSelection | undefined {
  const { territory, features } = belonging;
  const feature =
    features && hitNaturalFeature(features, point, pixels, streams);
  if (feature) {
    return { feature, territory };
  }
  const region = hitBelonging(belonging, point.x, point.y, pixels);
  if (region) {
    return region.children
      ? { compositeId: region.id, territory }
      : { regionId: region.id, territory };
  }
}
