import type { Territory } from "../data/types";
import type { InkView } from "../view/chart-view";
import { fileInView } from "../view/detail-level";
import type { BelongingLayer, BelongingRegion } from "./belonging";
import type { ResponsibilityOverlay } from "./responsibility-focus";

/**
 * The belonging layer as a repaint reads it: the applied layer with the
 * view's say over it. A pinned group stops leading once its focused file
 * leaves the view, a matched region joins and leads, and a composition
 * drawing goes when its file does. The scene resolves it once a frame and
 * every reader, the mark layers, the labels and the hit test, reads that
 * one answer, so the pigment and the labels agree. The same object comes
 * back while nothing it is resolved from has changed, and its derived
 * fields keep their identity through what moves every frame: a layer
 * keys on the fields it reads, and a reveal rebuilds only what reads the
 * drawn layer.
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

const withoutComposition = new WeakMap<
  ResponsibilityOverlay,
  ResponsibilityOverlay
>();

/**
 * A composition drawing goes when its file leaves the view. The overlay
 * without it is kept per overlay, so the responsibility layer sees the
 * same object while the drawing stays out of view, whatever else moves.
 */
function dropOffscreenComposition(
  responsibility: ResponsibilityOverlay | null,
  compositionVisible: boolean
): ResponsibilityOverlay | null {
  if (!responsibility || compositionVisible) {
    return responsibility;
  }
  let dropped = withoutComposition.get(responsibility);
  if (!dropped) {
    dropped = { ...responsibility, composition: undefined, trace: undefined };
    withoutComposition.set(responsibility, dropped);
  }
  return dropped;
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

const evidenceSets = new WeakMap<ResponsibilityOverlay, Set<string>>();

/**
 * The files an overlay names, members to route endpoints: one set per
 * overlay, so the files layer, which keys on it, is built once per overlay
 * and not again for a hover or a reveal.
 */
function evidenceOf(
  responsibility: ResponsibilityOverlay | null,
  focusedFileVisible: boolean
): Set<string> | undefined {
  if (!(responsibility && focusedFileVisible)) {
    return;
  }
  let evidence = evidenceSets.get(responsibility);
  if (evidence) {
    return evidence;
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
  evidence = new Set([
    ...responsibility.members,
    ...responsibility.related,
    ...responsibility.unresolved,
    ...endpoints,
  ]);
  evidenceSets.set(responsibility, evidence);
  return evidence;
}

/** Whether the selected island's focused file is in view; without a file or a view, it is. */
function focusedFileInView(
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
function compositionInView(
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

/** What a resolution was made from, and what it made: the last answer is handed back while these are the same. */
let lastResolved: { keys: readonly unknown[]; view: BelongingView } | undefined;

/**
 * The identities a resolution depends on: the options, and the two answers
 * the view gives. The view itself is not among them: the camera hands out
 * a new one each frame, and all the resolution reads of it is those two.
 */
function resolutionKeys(
  options: BelongingViewOptions,
  focusedFileVisible: boolean,
  compositionVisible: boolean
): readonly unknown[] {
  return [
    options.belonging,
    options.fileId,
    options.matches,
    options.responsibility,
    options.selected,
    options.territories,
    focusedFileVisible,
    compositionVisible,
  ];
}

function sameKeys(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((key, i) => Object.is(key, b[i]));
}

/**
 * Resolves the belonging layer and the overlay as the view shows them. The
 * answer is kept by the identities of the options and by whether the
 * focused file and the composition drawing are in view, so a pan that
 * moves neither hands back the same object; a new options object with the
 * same fields does too, since the keys are the fields.
 */
export function belongingView(options: BelongingViewOptions): BelongingView {
  const focusedFileVisible = focusedFileInView(options);
  const compositionVisible = compositionInView(options);
  const keys = resolutionKeys(options, focusedFileVisible, compositionVisible);
  if (lastResolved && sameKeys(lastResolved.keys, keys)) {
    return lastResolved.view;
  }
  const regions = territoriesById(options.territories);
  const unpinned = unpinOffscreenFocus(focusedFileVisible, options.belonging);
  const responsibility = dropOffscreenComposition(
    options.responsibility,
    compositionVisible
  );
  const belonging = withMatchedRegion(
    options.matches,
    regions.get(responsibility?.territoryId ?? ""),
    focusedFileVisible,
    unpinned
  );
  const resolved: BelongingView = {
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
  lastResolved = { keys, view: resolved };
  return resolved;
}
