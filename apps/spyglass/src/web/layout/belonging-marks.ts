import type { Polygon } from "../data/types";
import { inkStyle } from "../ladder/ink-table";
import { detailLevel, regionStrengthAt } from "../view/detail-level";
import type { BelongingLayer, BelongingRegion } from "./belonging";
import { clipPolygons, clipPolyline } from "./clip";
import { compositionInsideLand } from "./composition-placement";
import { naturalFeatureMarks } from "./feature-marks";
import type { Fill, Glyph, Mark, MarkAlpha, Stroke, StrokeDash } from "./marks";
import {
  dashOf,
  glyphOn,
  internAlpha,
  placePolygons,
  placePolylines,
  ringPoints,
} from "./marks";
import type { ResponsibilityOverlay } from "./responsibility-focus";

/** What the belonging layer's marks are built from: the view's belonging (`belonging-view.ts`) and the frame's state. */
export interface BelongingMarkInputs {
  /** The selected group, or the one under the pointer. */
  activeRegion: BelongingRegion | undefined;
  /** The group pinned before a matched region joined, kept while tracing. */
  baselineRegionId: string | undefined;
  belonging: BelongingLayer | null;
  /** The least strength the pigment keeps while an entered group's parents show. */
  districtFloor: number;
  /** Whether a composition drawing is in view, under which the pigment and features recede. */
  hasComposition: boolean;
  matches: BelongingRegion | undefined;
  /** The zoom the marks are built for; only the natural features' sizes read it. */
  pixels: number;
  responsibility: ResponsibilityOverlay | null;
  streams: boolean;
}

/** The anchor's square: its half side and pen, in CSS pixels. */
const anchorHalf = 4;
const anchorPen = 1;
/** A member drawn outside its district: a solid square this wide, in CSS pixels. */
const memberSquare = 3;

/** The outlines' pens, in CSS pixels. */
const regionPen = 0.7;
const activePen = 1.5;
const parentPen = 1;

/**
 * The zoom's say over the pigment: the districts' strength with the floor,
 * and, for every region but a retained one, the composition's veil and the
 * reveal. One table per build, so marks with the same base share an alpha
 * and the renderer batches them.
 */
function alphaTable(inputs: BelongingMarkInputs) {
  const { districtFloor, hasComposition } = inputs;
  const reveal = inputs.belonging?.reveal ?? 1;
  const strength = (pixels: number) =>
    regionStrengthAt(detailLevel(pixels, hasComposition), districtFloor);
  const share = internAlpha();
  return {
    /** A member of the layer as the zoom alone fades it. */
    plain: (base: number) =>
      share(`plain:${base}`, () => (pixels) => base * strength(pixels)),
    /** A region's ink, veiled by the composition and brought up by the reveal. */
    revealed: (base: number) =>
      share(
        `revealed:${base}`,
        () => (pixels) =>
          base *
          reveal *
          (1 - detailLevel(pixels, hasComposition).composition) *
          strength(pixels)
      ),
    strength,
    /** The uncertain outline's ink, which also surfaces with zoom. */
    uncertain: () =>
      share(
        "uncertain",
        () => (pixels) =>
          Math.min(0.3, pixels / 30) *
          reveal *
          (1 - detailLevel(pixels, hasComposition).composition) *
          strength(pixels)
      ),
  };
}

type Alphas = ReturnType<typeof alphaTable>;

const clippedOutlines = new WeakMap<
  Polygon[],
  WeakMap<Polygon[], number[][]>
>();
const clippedPieces = new WeakMap<number[][], WeakMap<Polygon[], number[][]>>();

/** A polygon set's rings as polylines cut to a clip, kept by both identities. */
function outlineWithin(polygons: Polygon[], clip: Polygon[]): number[][] {
  let byClip = clippedOutlines.get(polygons);
  if (!byClip) {
    byClip = new WeakMap();
    clippedOutlines.set(polygons, byClip);
  }
  let pieces = byClip.get(clip);
  if (!pieces) {
    pieces = polygons.flatMap((polygon) =>
      polygon.flatMap((ring) => clipPolyline(ringPoints(ring), clip))
    );
    byClip.set(clip, pieces);
  }
  return pieces;
}

/** Polylines cut again to a second clip, kept by both identities. */
function piecesWithin(pieces: number[][], clip: Polygon[]): number[][] {
  let byClip = clippedPieces.get(pieces);
  if (!byClip) {
    byClip = new WeakMap();
    clippedPieces.set(pieces, byClip);
  }
  let cut = byClip.get(clip);
  if (!cut) {
    cut = pieces.flatMap((piece) => clipPolyline(piece, clip));
    byClip.set(clip, cut);
  }
  return cut;
}

/** A region's wash and outline, cut to the coast and to any enclosing region, on the island. */
function regionMarks(
  region: BelongingRegion,
  clips: readonly Polygon[][],
  style: {
    dash?: StrokeDash;
    fill: MarkAlpha;
    outline: MarkAlpha;
    pen: number;
  },
  belonging: BelongingLayer
): Mark[] {
  const { territory } = belonging;
  const [coast = [], enclosing] = clips;
  let polygons = clipPolygons(region.polygons, coast);
  let outline = outlineWithin(region.polygons, coast);
  if (enclosing) {
    polygons = clipPolygons(polygons, enclosing);
    outline = piecesWithin(outline, enclosing);
  }
  const marks: Mark[] = placePolygons(polygons, territory.x, territory.y).map(
    (polygon): Fill => ({
      alpha: style.fill,
      colour: region.color,
      kind: "fill",
      on: territory,
      polygon,
    })
  );
  for (const points of placePolylines(outline, territory.x, territory.y)) {
    marks.push({
      alpha: style.outline,
      cap: "butt",
      colour: region.color,
      dash: style.dash,
      kind: "stroke",
      on: territory,
      points,
      width: style.pen,
    } satisfies Stroke);
  }
  return marks;
}

/** A parent's wash: the retained one firmest, a neighbour's faintest. */
function parentFill(retained: boolean, passive: boolean): number {
  if (retained) {
    return 0.12;
  }
  return passive ? 0.025 : 0.075;
}

function parentMarks(
  inputs: BelongingMarkInputs,
  belonging: BelongingLayer,
  enclosing: BelongingRegion | undefined,
  alphas: Alphas
): Mark[] {
  const { baselineRegionId, responsibility } = inputs;
  const { territory } = belonging;
  const marks: Mark[] = [];
  const parents = [
    ...(belonging.surroundings ?? []),
    ...(belonging.parents ?? []),
  ].filter((parent) => !parent.collection);
  for (const parent of parents) {
    const passive = belonging.surroundings?.includes(parent) === true;
    const retained =
      responsibility?.trace !== undefined && parent.id === baselineRegionId;
    const within = !parent.children && enclosing ? [enclosing.polygons] : [];
    marks.push(
      ...regionMarks(
        parent,
        [territory.coast, ...within],
        {
          // An entered responsibility's long dash keeps it apart from unresolved belonging.
          dash: parent.children
            ? undefined
            : dashOf(inkStyle("entered-outline")),
          fill: alphas.plain(parentFill(retained, passive)),
          outline: alphas.plain(passive ? 0.2 : 0.45),
          pen: parentPen,
        },
        belonging
      )
    );
    if (parent.anchor) {
      marks.push(
        glyphOn(territory, parent.anchor, {
          alpha: alphas.plain(passive ? 0.35 : 0.85),
          colour: parent.color,
          shape: "frame",
          size: 2 * anchorHalf + anchorPen,
          weight: anchorPen,
        })
      );
    }
  }
  return marks;
}

function districtMarks(
  inputs: BelongingMarkInputs,
  belonging: BelongingLayer,
  enclosing: BelongingRegion | undefined,
  alphas: Alphas
): Mark[] {
  const { activeRegion, baselineRegionId, matches, responsibility } = inputs;
  const emphasis = belonging.emphasis ?? 1;
  const marks: Mark[] = [];
  for (const region of belonging.regions) {
    const active = region === activeRegion;
    const retained = responsibility?.trace && region.id === baselineRegionId;
    const clips = [
      belonging.territory.coast,
      ...(enclosing && region !== matches ? [enclosing.polygons] : []),
    ];
    let fill: MarkAlpha;
    let outline: MarkAlpha;
    if (retained) {
      fill = alphas.plain(0.12);
      outline = alphas.plain(0.2);
    } else if (active) {
      fill = alphas.revealed(0.14 + 0.16 * emphasis);
      outline = alphas.revealed(0.3 + 0.55 * emphasis);
    } else if (region.uncertain) {
      fill = alphas.revealed(0.045);
      outline = alphas.uncertain();
    } else {
      fill = alphas.revealed(0.14);
      outline = alphas.revealed(0.3);
    }
    marks.push(
      ...regionMarks(
        region,
        clips,
        {
          dash: region.uncertain
            ? dashOf(inkStyle("unresolved-outline"))
            : undefined,
          fill,
          outline,
          pen: active ? activePen : regionPen,
        },
        belonging
      )
    );
  }
  return marks;
}

/** A member of the entered group outside its district: a solid square in the district's ink. */
function memberMarks(
  belonging: BelongingLayer,
  enclosing: BelongingRegion,
  alphas: Alphas
): Glyph[] {
  const { territory } = belonging;
  const members =
    belonging.files ?? belonging.regions.flatMap((region) => region.members);
  const alpha = alphas.plain(0.65);
  const marks: Glyph[] = [];
  for (const file of members) {
    if (compositionInsideLand(file.x, file.y, enclosing.polygons)) {
      continue;
    }
    marks.push(
      glyphOn(territory, file, {
        alpha,
        colour: enclosing.color,
        shape: "square",
        size: memberSquare,
      })
    );
  }
  return marks;
}

/** Landmarks and marsh stay through file zoom; they recede only under composition. */
function featureStrength(
  hasComposition: boolean,
  reveal: number
): (pixels: number) => number {
  return (pixels) => {
    const detail = detailLevel(pixels, hasComposition);
    return (
      Math.min(1, detail.districts + detail.files) *
      (1 - detail.composition * 0.8) *
      reveal
    );
  };
}

/**
 * District and responsibility pigment, and the natural features, on the
 * island they belong to, every mark draped on its relief and cut to its
 * coast: the entered group's parents and their neighbours, then each
 * district's wash and outline, the features, and the members drawn outside
 * their district. Built again whenever the applied layer, the hover, the
 * reveal or the overlay changes; how strongly each mark shows at a zoom is
 * its alpha's.
 */
export function belongingMarks(inputs: BelongingMarkInputs): Mark[] {
  const { belonging, hasComposition, pixels, streams } = inputs;
  if (!belonging) {
    return [];
  }
  const alphas = alphaTable(inputs);
  const enclosing = belonging.parents?.find(
    (region) => region.children && !region.collection
  );
  const marks: Mark[] = [
    ...parentMarks(inputs, belonging, enclosing, alphas),
    ...districtMarks(inputs, belonging, enclosing, alphas),
  ];
  if (belonging.features) {
    marks.push(
      ...naturalFeatureMarks(belonging.features, {
        focus: belonging.featureFocus,
        on: belonging.territory,
        pixels,
        streams,
        strength: featureStrength(hasComposition, belonging.reveal ?? 1),
      })
    );
  }
  if (enclosing) {
    marks.push(...memberMarks(belonging, enclosing, alphas));
  }
  return marks;
}
