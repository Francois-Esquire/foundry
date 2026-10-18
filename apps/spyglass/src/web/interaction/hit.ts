import type { Vector3 } from "three";
import type { SpyglassData } from "../data/types";
import type { BelongingLayer } from "../layout/belonging";
import { hitBelonging } from "../layout/belonging";
import type { MapLabel } from "../layout/labels";
import { hitNaturalFeature } from "../layout/natural-feature-inspection";
import { islandAt } from "../layout/polygons";
import type { ResponsibilityOverlay } from "../layout/responsibility-focus";
import type { InkView } from "../view/chart-view";
import { detailLevel, fileInView } from "../view/detail-level";
import { hitComposition } from "./composition-hit";
import type { SpyglassSelection } from "./selection";

/** What the repaint shows, as a hit test reads it. */
export interface HitContext {
  belonging: BelongingLayer | null;
  /** The spyglass being drawn, with any territory relayout applied. */
  data: SpyglassData;
  /** The labels to hit before the land beneath them: the last repaint's, or this repaint's while it runs. */
  labels: readonly MapLabel[];
  /** The terrain surface above a point on the paper, if land stands there. */
  pickTerrain: (point: Vector3) => Vector3 | undefined;
  reducedMotion: boolean;
  responsibility: ResponsibilityOverlay | null;
  streams: boolean;
  view: InkView;
  visibility: { composition: boolean; files: boolean };
}

/**
 * The placed label under a point on the chart, which a click selects. The
 * domain's name and a frame's label are captions, not places, so a click
 * passes through them.
 */
export function labelUnder(
  labels: readonly MapLabel[],
  x: number,
  y: number
): MapLabel | undefined {
  return labels.find(
    (label) =>
      label.kind !== "domain" &&
      label.kind !== "frame" &&
      Math.abs(x - label.x) < label.width / 2 &&
      y >= label.y - label.height &&
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
  const label = labelUnder(context.labels, point.x, -point.y);
  if (label?.territory) {
    return {
      compositeId: label.compositeId,
      file: label.file,
      regionId: label.regionId,
      territory: label.territory,
    };
  }
  const surface = context.pickTerrain(point);
  if (surface) {
    point.copy(surface);
  }
  const overlay = overlayInView(
    context.responsibility,
    context.data,
    context.view
  );
  if (overlay && context.visibility.composition) {
    const symbol = hitVisibleComposition(overlay, context, point);
    if (symbol) {
      return symbol;
    }
  }
  return hitLand(context, overlay, point);
}

function hitLand(
  context: HitContext,
  overlay: ResponsibilityOverlay | null,
  point: Vector3
): SpyglassSelection | null {
  const { belonging, data, view } = context;
  const pixels = view.pixelsPerUnit;
  const level = detailLevel(
    pixels,
    (overlay?.composition?.marks.length ?? 0) > 0
  );
  const closest = hitTerritory(data, point, context.visibility, pixels);
  const land = islandAt({ x: point.x, y: -point.y }, data.territories);
  const onBelonging =
    belonging && land?.id === belonging.territory.id && !closest?.file;
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
  if (land) {
    return closest?.territory.id === land.id ? closest : { territory: land };
  }
  return null;
}

/** The nearest file within reach of the point, as the island it sits on; the file itself only when files are drawn and it is close. */
function hitTerritory(
  data: SpyglassData,
  point: Vector3,
  visibility: { composition: boolean; files: boolean },
  pixels: number
): SpyglassSelection | null {
  let closest: SpyglassSelection | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const territory of data.territories) {
    const x = point.x - territory.x;
    const y = -point.y - territory.y;
    for (const file of territory.files) {
      const d = Math.hypot(file.x - x, file.y - y);
      if (d < distance && d < 20) {
        distance = d;
        closest = {
          territory,
          ...(visibility.files && d < Math.max(1, 5 / pixels) ? { file } : {}),
        };
      }
    }
  }
  return closest;
}

/** A composition drawing goes when its file leaves the view, so nothing hits it. */
function overlayInView(
  overlay: ResponsibilityOverlay | null,
  data: SpyglassData,
  view: InkView
): ResponsibilityOverlay | null {
  if (
    overlay?.composition &&
    !fileInView(
      data.territories.find((item) => item.id === overlay.territoryId),
      overlay.composition.fileId,
      view
    )
  ) {
    return { ...overlay, composition: undefined, trace: undefined };
  }
  return overlay;
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
