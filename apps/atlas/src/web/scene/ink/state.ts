import type { BelongingLayer, BelongingRegion } from "../../belonging";
import type { ResponsibilityOverlay } from "../../responsibility-focus";
import type { AtlasData, Territory } from "../../types";
import type { atlasBoundaries, BoundaryVisibility } from "../boundaries";
import { detailLevel, fileInView } from "../detail-level";
import type { InkView, MapLabel } from "../exploration";
import type { SeaRipple } from "../sea-ripples";
import type { ContourLine } from "../topography";

/** What one ink repaint draws: the map's state as the scene holds it. */
export interface InkOptions {
  belonging?: BelongingLayer | null;
  /** The layout's outlines and which of them a developer turned on. */
  boundaries?: {
    layers: ReturnType<typeof atlasBoundaries>;
    visible: BoundaryVisibility;
  };
  data: AtlasData;
  /** A developer session: each layer is timed (`timeStage`). */
  developer?: boolean;
  fileId?: string | null;
  /**
   * The island to ink under the pointer, asked once the labels are placed,
   * since a label is hit before the land beneath it.
   */
  hovered?: (labels: readonly MapLabel[]) => Territory | null;
  /** The lettering overlay; without it, labels are painted on the ink canvas. */
  lettering?: {
    canvas: HTMLCanvasElement;
    project: (label: MapLabel) => MapLabel;
  };
  matches?: BelongingRegion;
  responsibility?: ResponsibilityOverlay | null;
  ripples?: readonly SeaRipple[];
  selected?: string | null;
  showConnections?: boolean;
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
  data: AtlasData;
  detail: InkDetail;
  /** The files an overlay is about; every other file recedes. */
  evidenceFiles: Set<string> | undefined;
  fileId: string | null;
  hovered: InkOptions["hovered"];
  /** Where labels and grid references are lettered. */
  labelContext: CanvasRenderingContext2D;
  /** Placed by the labels layer, then read by the layers that clear them. */
  labels: MapLabel[];
  matches: BelongingRegion | undefined;
  pixels: number;
  project: (label: MapLabel) => MapLabel;
  /** How strongly district pigment shows at this zoom. */
  regionStrength: number;
  regions: Map<string, Territory>;
  responsibility: ResponsibilityOverlay | null;
  ripples: readonly SeaRipple[];
  selected: string | null;
  showConnections: boolean;
  streams: boolean;
  topography: ContourLine[];
  view: InkView | undefined;
}

/** A pinned group stops leading once its focused file leaves the view. */
function unpinOffscreenFocus(
  focusedFileVisible: boolean,
  belonging: BelongingLayer | null
): BelongingLayer | null {
  return !focusedFileVisible && belonging
    ? { ...belonging, pinned: undefined }
    : belonging;
}

/** A composition drawing goes when its file leaves the view. */
function dropOffscreenComposition(
  view: InkView | undefined,
  responsibility: ResponsibilityOverlay | null,
  regions: Map<string, Territory>
): ResponsibilityOverlay | null {
  if (
    view &&
    responsibility?.composition &&
    !fileInView(
      regions.get(responsibility.territoryId),
      responsibility.composition.fileId,
      view
    )
  ) {
    return { ...responsibility, composition: undefined, trace: undefined };
  }
  return responsibility;
}

/** A matched region joins the belonging layer and leads it. */
function withMatchedRegion(
  matches: BelongingRegion | undefined,
  matchTerritory: Territory | undefined,
  focusedFileVisible: boolean,
  belonging: BelongingLayer | null
): BelongingLayer | null {
  if (matches && matchTerritory && focusedFileVisible) {
    return {
      ...belonging,
      pinned: matches.id,
      regions: [...(belonging?.regions ?? []), matches],
      territory: matchTerritory,
    };
  }
  return belonging;
}

/** The files an overlay names, members to route endpoints. */
function evidenceOf(
  responsibility: ResponsibilityOverlay | null,
  focusedFileVisible: boolean
): Set<string> | undefined {
  if (!(responsibility && focusedFileVisible)) {
    return;
  }
  const endpoints = responsibility.routes
    ? [
        ...responsibility.routes.baseline,
        ...responsibility.routes.proposed,
      ].flatMap((route) =>
        [route.source, route.target].flatMap((endpoint) =>
          endpoint.kind === "file" ? [endpoint.id] : []
        )
      )
    : [];
  return new Set([
    ...responsibility.members,
    ...responsibility.related,
    ...responsibility.unresolved,
    ...endpoints,
  ]);
}

/** Resolves the options into the state every layer reads. */
export function inkState(
  ctx: CanvasRenderingContext2D,
  labelContext: CanvasRenderingContext2D,
  options: InkOptions
): InkState {
  const { data, matches, view } = options;
  const selected = options.selected ?? null;
  const fileId = options.fileId ?? null;
  const regions = new Map(data.territories.map((p) => [p.id, p]));
  const pixels = view?.pixelsPerUnit ?? 1;
  const focusedFileVisible =
    !(fileId && view) || fileInView(regions.get(selected ?? ""), fileId, view);
  const unpinned = unpinOffscreenFocus(
    focusedFileVisible,
    options.belonging ?? null
  );
  const responsibility = dropOffscreenComposition(
    view,
    options.responsibility ?? null,
    regions
  );
  const detail = detailLevel(
    pixels,
    (responsibility?.composition?.marks.length ?? 0) > 0
  );
  const regionStrength = Math.max(
    detail.districts,
    unpinned?.parents?.length ? 0.2 : 0
  );
  const belonging = withMatchedRegion(
    matches,
    regions.get(responsibility?.territoryId ?? ""),
    focusedFileVisible,
    unpinned
  );
  return {
    activeRegion: belonging?.regions.find(
      (region) => region.id === (belonging.hovered ?? belonging.pinned)
    ),
    baselineRegionId: unpinned?.pinned,
    belonging,
    boundaries: options.boundaries,
    ctx,
    data,
    detail,
    evidenceFiles: evidenceOf(responsibility, focusedFileVisible),
    fileId,
    hovered: options.hovered,
    labelContext,
    labels: [],
    matches,
    pixels,
    project: options.lettering?.project ?? ((label) => label),
    regionStrength,
    regions,
    responsibility,
    ripples: options.ripples ?? [],
    selected,
    showConnections: options.showConnections ?? false,
    streams: options.streams ?? false,
    topography: options.topography ?? [],
    view,
  };
}
