import type { SpyglassData, Territory } from "../../data/types";
import type { BelongingLayer, BelongingRegion } from "../../layout/belonging";
import { belongingView } from "../../layout/belonging-view";
import type { BoundaryLayers } from "../../layout/boundaries";
import {
  type DomainExtent,
  type DomainRef,
  domainExtent,
} from "../../layout/domain-extent";
import type { MapLabel } from "../../layout/labels";
import type { ResponsibilityOverlay } from "../../layout/responsibility-focus";
import type { ContourLine } from "../../layout/topography";
import type { BoundaryVisibility } from "../../settings/boundary-settings";
import type { InkView } from "../../view/chart-view";
import { detailLevel, regionStrengthAt } from "../../view/detail-level";

/** What one ink repaint draws: the map's state as the scene holds it. */
export interface InkOptions {
  belonging?: BelongingLayer | null;
  /** The layout's outlines and which of them a developer turned on. */
  boundaries?: {
    layers: BoundaryLayers;
    visible: BoundaryVisibility;
  };
  data: SpyglassData;
  /** A developer session: each layer is timed (`timeStage`). */
  developer?: boolean;
  /** The declared domain the reader chose to draw across the islands. */
  domain?: DomainRef | null;
  fileId?: string | null;
  /**
   * The island to ink under the pointer, asked once the labels are placed,
   * since a label is hit before the land beneath it.
   */
  hovered?: (labels: readonly MapLabel[]) => Territory | null;
  /** The labels the labels layer placed for this frame, which the layers clear around; none without it. */
  labels?: readonly MapLabel[];
  matches?: BelongingRegion;
  responsibility?: ResponsibilityOverlay | null;
  selected?: string | null;
  streams?: boolean;
  topography?: ContourLine[];
  /** The viewport; without it, the whole chart at one pixel per unit. */
  view?: InkView;
}

type InkDetail = ReturnType<typeof detailLevel>;

/** One repaint's state, resolved once and read by every ink layer in turn. */
export interface InkState {
  /** The selected group, or the one under the pointer. */
  activeRegion: BelongingRegion | undefined;
  /** The group pinned before a matched region joined, kept while tracing. */
  baselineRegionId: string | undefined;
  belonging: BelongingLayer | null;
  boundaries: InkOptions["boundaries"];
  ctx: CanvasRenderingContext2D;
  data: SpyglassData;
  detail: InkDetail;
  /** Where the chosen domain lies; null when none is chosen. */
  domain: DomainExtent | null;
  /** The files an overlay is about; every other file recedes. */
  evidenceFiles: Set<string> | undefined;
  fileId: string | null;
  hovered: InkOptions["hovered"];
  /** Placed by the labels layer (`scene/labels/`) before the repaint, and read by the layers that clear around them. */
  labels: readonly MapLabel[];
  matches: BelongingRegion | undefined;
  pixels: number;
  /** How strongly district pigment shows at this zoom. */
  regionStrength: number;
  responsibility: ResponsibilityOverlay | null;
  selected: string | null;
  streams: boolean;
  topography: ContourLine[];
  view: InkView | undefined;
}

/** Resolves the options into the state every layer reads. */
export function inkState(
  ctx: CanvasRenderingContext2D,
  options: InkOptions
): InkState {
  const { data, matches, view } = options;
  const selected = options.selected ?? null;
  const fileId = options.fileId ?? null;
  const pixels = view?.pixelsPerUnit ?? 1;
  const {
    activeRegion,
    baselineRegionId,
    belonging,
    districtFloor,
    evidenceFiles,
    hasComposition,
    responsibility,
  } = belongingView({
    belonging: options.belonging ?? null,
    fileId,
    matches,
    responsibility: options.responsibility ?? null,
    selected,
    territories: data.territories,
    view,
  });
  const detail = detailLevel(pixels, hasComposition);
  return {
    activeRegion,
    baselineRegionId,
    belonging,
    boundaries: options.boundaries,
    ctx,
    data,
    detail,
    domain: options.domain ? domainExtent(data, options.domain) : null,
    evidenceFiles,
    fileId,
    hovered: options.hovered,
    labels: options.labels ?? [],
    matches,
    pixels,
    regionStrength: regionStrengthAt(detail, districtFloor),
    responsibility,
    selected,
    streams: options.streams ?? false,
    topography: options.topography ?? [],
    view,
  };
}
