import type { Territory } from "../data/types";
import type { InkView } from "../view/chart-view";
import { fileInView } from "../view/detail-level";
import type { BelongingLayer, BelongingRegion } from "./belonging";
import type { ResponsibilityOverlay } from "./responsibility-focus";

/**
 * The belonging layer as a repaint reads it: the applied layer with the
 * view's say over it. A pinned group stops leading once its focused file
 * leaves the view, a matched region joins and leads, and a composition
 * drawing goes when its file does. The ink layers and the mark layers read
 * the same answer, so the pigment and the labels agree.
 */
export interface BelongingView {
  /** The selected group, or the one under the pointer. */
  activeRegion: BelongingRegion | undefined;
  /** The group pinned before a matched region joined, kept while tracing. */
  baselineRegionId: string | undefined;
  belonging: BelongingLayer | null;
  /** The least strength district pigment keeps while an entered group's parents show. */
  districtFloor: number;
  /** The files an overlay is about; every other file recedes. */
  evidenceFiles: Set<string> | undefined;
  /** Whether a composition drawing is in view, which brings the composition detail level in. */
  hasComposition: boolean;
  responsibility: ResponsibilityOverlay | null;
}

/** What the view holds of the belonging layer: the same across the island's repaint, so a memo keys on it. */
export interface BelongingViewOptions {
  belonging: BelongingLayer | null;
  fileId: string | null;
  matches: BelongingRegion | undefined;
  responsibility: ResponsibilityOverlay | null;
  selected: string | null;
  territories: readonly Territory[];
  /** The viewport; without it, the whole chart is in view. */
  view: InkView | undefined;
}

const territoryMaps = new WeakMap<
  readonly Territory[],
  Map<string, Territory>
>();

/** The islands by id, kept per set of islands. */
function territoriesById(
  territories: readonly Territory[]
): Map<string, Territory> {
  let byId = territoryMaps.get(territories);
  if (!byId) {
    byId = new Map(territories.map((territory) => [territory.id, territory]));
    territoryMaps.set(territories, byId);
  }
  return byId;
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

/** Whether the selected island's focused file is in view; without a file or a view, it is. */
export function focusedFileInView(
  options: Pick<
    BelongingViewOptions,
    "fileId" | "selected" | "territories" | "view"
  >
): boolean {
  const { fileId, selected, territories, view } = options;
  return (
    !(fileId && view) ||
    fileInView(territoriesById(territories).get(selected ?? ""), fileId, view)
  );
}

/** Whether the overlay's composition drawing is in view; without a drawing or a view, it is. */
export function compositionInView(
  options: Pick<BelongingViewOptions, "responsibility" | "territories" | "view">
): boolean {
  const { responsibility, territories, view } = options;
  return (
    !(view && responsibility?.composition) ||
    fileInView(
      territoriesById(territories).get(responsibility.territoryId),
      responsibility.composition.fileId,
      view
    )
  );
}

/** Resolves the belonging layer and the overlay as the view shows them. */
export function belongingView(options: BelongingViewOptions): BelongingView {
  const { matches, view } = options;
  const regions = territoriesById(options.territories);
  const focusedFileVisible = focusedFileInView(options);
  const unpinned = unpinOffscreenFocus(focusedFileVisible, options.belonging);
  const responsibility = dropOffscreenComposition(
    view,
    options.responsibility,
    regions
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
    districtFloor: unpinned?.parents?.length ? 0.2 : 0,
    evidenceFiles: evidenceOf(responsibility, focusedFileVisible),
    hasComposition: (responsibility?.composition?.marks.length ?? 0) > 0,
    responsibility,
  };
}
