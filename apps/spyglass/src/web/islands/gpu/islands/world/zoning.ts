/**
 * The world plan (world.ts) as the zoning map draws it
 * (shaders/maps/zoning.wgsl, WORLD.md layer 2): its zones as polygons
 * that grow trees, shrubs and open ground; rings along the outlines that
 * grow a hedge or a field's edge of trees; and what it reserves, its
 * parcels and buildings as polygons and its roads as capsule segments.
 * Packed once when the plan is set; the map is baked from it on the GPU.
 */
import type { Point } from "../../../data/chart";
import type { ParcelKind, WorldPlan, ZoneKind } from "./world";

/** What a zone grows, each 0 to 1: the zoning map's g, b and a. */
export interface Growth {
  /** Open ground: how far the town has left the land wild. */
  readonly open: number;
  readonly shrubs: number;
  readonly trees: number;
}

/**
 * Each zone kind's growth. A field's crops are its surface's, so it grows
 * no trees on itself; its edge does (`FIELD_EDGE`).
 */
export const ZONE_GROWTH: Readonly<Record<ZoneKind, Growth>> = {
  core: { open: 0, shrubs: 0, trees: 0 },
  field: { open: 1, shrubs: 0.05, trees: 0 },
  garden: { open: 0, shrubs: 0.8, trees: 0.25 },
  grove: { open: 0.6, shrubs: 0.35, trees: 0.95 },
  meadow: { open: 1, shrubs: 0.12, trees: 0.08 },
  pines: { open: 0.6, shrubs: 0.15, trees: 0.85 },
  shore: { open: 0.8, shrubs: 0.25, trees: 0.05 },
};

/**
 * Zone kinds in draw order: the wild land first, the town's own last, so
 * where zones overlap the later kind's growth wins.
 */
export const ZONE_ORDER: readonly ZoneKind[] = [
  "meadow",
  "shore",
  "field",
  "pines",
  "grove",
  "garden",
  "core",
];

/**
 * Parcels that leave their ground to grow: a garden is planted, not
 * paved, so it is drawn as a garden zone. Every other parcel is reserved.
 */
const GROWING_PARCELS: ReadonlySet<ParcelKind> = new Set<ParcelKind>([
  "garden",
]);

/** A ring along an outline: where it runs and what it grows. */
interface Ring {
  /** Chart units either side of its middle it fades out over. */
  readonly half: number;
  /** Chart units outside the outline its middle runs; inside when negative. */
  readonly offset: number;
  readonly shrubs: number;
  readonly trees: number;
}

/** A hedge just outside a parcel's outline, where the reserve eases off. */
export const HEDGE: Ring = { half: 0.5, offset: 0.6, shrubs: 1, trees: 0 };
/** A line of trees along a field's edge, just inside it. */
export const FIELD_EDGE: Ring = {
  half: 1,
  offset: -0.75,
  shrubs: 0.1,
  trees: 0.4,
};

/** Floats a polygon (zoning.wgsl `polygons`) and a road segment (`segments`). */
const POLYGON_FLOATS = 12;
const SEGMENT_FLOATS = 8;

/** Instances of one draw: the first in its buffer and how many. */
interface Run {
  readonly count: number;
  readonly first: number;
}

export interface PackedZoning {
  /** Every outline's points, x and y, one after another. */
  readonly points: Float32Array<ArrayBuffer>;
  /** Three vec4f a polygon: zones by kind, then rings, then reserves. */
  readonly polygons: Float32Array<ArrayBuffer>;
  /** Each reserved polygon: parcels, then buildings' footprints. */
  readonly reserves: Run;
  /** Each ring along an outline. */
  readonly rings: Run;
  readonly segmentCount: number;
  /** Two vec4f a road segment: its ends; its half width. */
  readonly segments: Float32Array<ArrayBuffer>;
  /** Each zone kind's polygons, in `ZONE_ORDER`. */
  readonly zones: Readonly<Record<ZoneKind, Run>>;
}

/** A building's footprint, from its middle, turn and half sizes (world.ts). */
function footprintOf(
  at: Point,
  turn: number,
  half: readonly [number, number]
): Point[] {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const [hx, hz] = half;
  const corners: Point[] = [
    [-hx, -hz],
    [hx, -hz],
    [hx, hz],
    [-hx, hz],
  ];
  return corners.map(([x, z]) => [
    at[0] + c * x - s * z,
    at[1] + s * x + c * z,
  ]);
}

interface Shape {
  readonly growth: readonly [number, number];
  readonly outline: readonly Point[];
  readonly ring: readonly [number, number];
}

/** The polygons' and points' arrays, filled in order. */
function packPolygons(shapes: readonly Shape[]) {
  const pointCount = shapes.reduce((n, s) => n + s.outline.length, 0);
  const points = new Float32Array(Math.max(pointCount, 1) * 2);
  const polygons = new Float32Array(
    Math.max(shapes.length, 1) * POLYGON_FLOATS
  );
  let first = 0;
  for (const [i, shape] of shapes.entries()) {
    let low: Point = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    let high: Point = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const [k, p] of shape.outline.entries()) {
      points.set(p, (first + k) * 2);
      low = [Math.min(low[0], p[0]), Math.min(low[1], p[1])];
      high = [Math.max(high[0], p[0]), Math.max(high[1], p[1])];
    }
    polygons.set(
      [
        first,
        shape.outline.length,
        ...shape.growth,
        ...low,
        ...high,
        ...shape.ring,
        0,
        0,
      ],
      i * POLYGON_FLOATS
    );
    first += shape.outline.length;
  }
  return { points, polygons };
}

/** Every road's centreline as segments: its two ends and half its width. */
function packSegments(plan: WorldPlan) {
  const rows: number[][] = [];
  for (const road of plan.roads) {
    for (let k = 1; k < road.points.length; k += 1) {
      const a = road.points[k - 1];
      const b = road.points[k];
      if (a && b) {
        rows.push([a[0], a[1], b[0], b[1], road.width / 2, 0, 0, 0]);
      }
    }
  }
  const segments = new Float32Array(Math.max(rows.length, 1) * SEGMENT_FLOATS);
  for (const [i, row] of rows.entries()) {
    segments.set(row, i * SEGMENT_FLOATS);
  }
  return { segmentCount: rows.length, segments };
}

const polygonal = (outline: readonly Point[]) => outline.length >= 3;

/** The plan's zones, rings and reserves as the zoning draws read them. */
export function packZoning(plan: WorldPlan): PackedZoning {
  const shapes: Shape[] = [];
  const zones = {} as Record<ZoneKind, Run>;
  const growing = plan.parcels.filter(
    (p) => GROWING_PARCELS.has(p.kind) && polygonal(p.outline)
  );
  for (const kind of ZONE_ORDER) {
    const { trees, shrubs } = ZONE_GROWTH[kind];
    const first = shapes.length;
    const outlines = plan.zones
      .filter((z) => z.kind === kind && polygonal(z.outline))
      .map((z) => z.outline);
    if (kind === "garden") {
      outlines.push(...growing.map((p) => p.outline));
    }
    for (const outline of outlines) {
      shapes.push({ growth: [trees, shrubs], outline, ring: [0, 0] });
    }
    zones[kind] = { count: shapes.length - first, first };
  }
  const ringsFirst = shapes.length;
  const ring = (outline: readonly Point[], r: Ring) =>
    shapes.push({
      growth: [r.trees, r.shrubs],
      outline,
      ring: [r.offset, r.half],
    });
  for (const parcel of plan.parcels) {
    if (parcel.edge === "hedge" && polygonal(parcel.outline)) {
      ring(parcel.outline, HEDGE);
    }
  }
  for (const zone of plan.zones) {
    if (zone.kind === "field" && polygonal(zone.outline)) {
      ring(zone.outline, FIELD_EDGE);
    }
  }
  const rings = { count: shapes.length - ringsFirst, first: ringsFirst };
  const reservesFirst = shapes.length;
  const reserve = (outline: readonly Point[]) =>
    shapes.push({ growth: [0, 0], outline, ring: [0, 0] });
  for (const parcel of plan.parcels) {
    if (!GROWING_PARCELS.has(parcel.kind) && polygonal(parcel.outline)) {
      reserve(parcel.outline);
    }
  }
  for (const building of plan.buildings) {
    reserve(footprintOf(building.at, building.turn, building.half));
  }
  const reserves = {
    count: shapes.length - reservesFirst,
    first: reservesFirst,
  };
  return {
    ...packPolygons(shapes),
    ...packSegments(plan),
    reserves,
    rings,
    zones,
  };
}
