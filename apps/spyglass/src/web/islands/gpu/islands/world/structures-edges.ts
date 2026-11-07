/**
 * What bounds the parcels (world.ts `Parcel.edge`): low concrete block
 * walls, clipped hedges or fences along the sides away from the road, and
 * along the road a short length of the same that leaves the entrance and
 * the parking open. Each edge is cut into short pieces, each on a site of
 * its own, so a wall steps with the ground instead of floating over it.
 * Pieces sit just inside their parcel, so two parcels that share a side
 * do not draw into each other, and a side already walled by a neighbour
 * is not walled twice.
 */
import type { Point } from "../../../data/chart";
import { COLORS } from "./structures-palette";
import { type TownPart, townPart } from "./town-parts";
import type { Building, Parcel, Road } from "./world";

/** A piece of edge on the chart, standing on its own site. */
export interface EdgePiece {
  readonly at: Point;
  readonly part: TownPart;
  readonly turn: number;
}

/** The longest piece, chart units: short enough to step with the ground. */
const PIECE = 2;
/** How far inside its parcel an edge stands past its own half thickness. */
const INSET = 0.03;
/** How much nearer the road than the parcel's farthest-in front edge another edge may be and still be front. */
const FRONT_SLACK = 0.6;
/** An entrance's half width round a building's door, and a car's width beside it. */
const GATE_HALF = 0.45;
const DRIVE = 0.95;
/** Two edges this close and this parallel are one shared side. */
const SHARED_GAP = 0.45;
const SHARED_COS = 0.95;

interface Style {
  readonly height: number;
  readonly part: (half: readonly [number, number], height: number) => TownPart;
  readonly thick: number;
}

const STYLES: Readonly<Record<Exclude<Parcel["edge"], "none">, Style>> = {
  fence: {
    height: 0.28,
    part: (half, height) =>
      townPart({
        color: COLORS.fence,
        half,
        material: "steel",
        ownSite: true,
        shape: "open",
        style: "fence",
        wall: height,
      }),
    thick: 0.03,
  },
  hedge: {
    height: 0.34,
    part: (half, height) =>
      townPart({
        color: COLORS.hedge,
        half,
        material: "hedge",
        ownSite: true,
        shades: true,
        shape: "box",
        wall: height,
      }),
    thick: 0.17,
  },
  wall: {
    height: 0.3,
    part: (half, height) =>
      townPart({
        color: COLORS.block,
        half,
        material: "block",
        ownSite: true,
        shades: true,
        shape: "box",
        wall: height,
      }),
    thick: 0.07,
  },
};

/** Grounds that want a tall mesh fence rather than a garden one. */
const TALL_FENCE: ReadonlySet<Parcel["kind"]> = new Set([
  "pitch",
  "track",
  "playground",
]);
const TALL_FENCE_HEIGHT = 0.75;

function distanceToLine(p: Point, points: readonly Point[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let k = 0; k + 1 < points.length; k += 1) {
    const a = points[k] as Point;
    const b = points[k + 1] as Point;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length2 = dx * dx + dz * dz;
    const t =
      length2 > 0
        ? Math.min(
            Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length2, 0),
            1
          )
        : 0;
    best = Math.min(
      best,
      Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz)
    );
  }
  return best;
}

interface Side {
  readonly a: Point;
  readonly b: Point;
  readonly front: boolean;
}

/** A parcel's sides, each marked whether it faces its road. */
function sidesOf(parcel: Parcel, road: Road | undefined): Side[] {
  const { outline } = parcel;
  const pairs = outline.map(
    (a, k) => [a, outline[(k + 1) % outline.length] as Point] as const
  );
  if (!road) {
    return pairs.map(([a, b]) => ({ a, b, front: false }));
  }
  const reach = pairs.map(([a, b]) =>
    distanceToLine([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], road.points)
  );
  const nearest = Math.min(...reach);
  return pairs.map(([a, b], k) => ({
    a,
    b,
    front: (reach[k] ?? 0) <= nearest + FRONT_SLACK,
  }));
}

/**
 * The open stretch of a front side, as fractions along it: the gate in
 * front of the building's door, and the drive to whichever side has more
 * of the front.
 */
function gateOf(side: Side, building: Building | undefined): [number, number] {
  const dx = side.b[0] - side.a[0];
  const dz = side.b[1] - side.a[1];
  const length = Math.hypot(dx, dz);
  if (!building || length === 0) {
    return [0.35, 0.65];
  }
  const door: Point = [
    building.at[0] - Math.sin(building.turn) * building.half[1],
    building.at[1] + Math.cos(building.turn) * building.half[1],
  ];
  const t =
    ((door[0] - side.a[0]) * dx + (door[1] - side.a[1]) * dz) /
    (length * length);
  const gate = GATE_HALF / length;
  const drive = DRIVE / length;
  // The drive goes on the longer stretch beside the gate.
  return t > 0.5 ? [t - gate - drive, t + gate] : [t - gate, t + gate + drive];
}

interface Laid {
  readonly dir: Point;
  readonly half: number;
  readonly mid: Point;
}

/** Whether a side is already walled by a parcel laid before. */
function shared(laid: readonly Laid[], a: Point, b: Point): boolean {
  const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dir: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  return laid.some((o) => {
    const cos = Math.abs(o.dir[0] * dir[0] + o.dir[1] * dir[1]);
    if (cos < SHARED_COS) {
      return false;
    }
    const off: Point = [mid[0] - o.mid[0], mid[1] - o.mid[1]];
    const across = Math.abs(off[0] * o.dir[1] - off[1] * o.dir[0]);
    const along = Math.abs(off[0] * o.dir[0] + off[1] * o.dir[1]);
    return across < SHARED_GAP && along < o.half;
  });
}

/** Two turned boxes' overlap, by their separating axes: each box's own two. */
function boxesOverlap(
  a: Point,
  turnA: number,
  halfA: readonly [number, number],
  b: Point,
  turnB: number,
  halfB: readonly [number, number]
): boolean {
  const axesOf = (turn: number): Point[] => [
    [Math.cos(turn), Math.sin(turn)],
    [-Math.sin(turn), Math.cos(turn)],
  ];
  const ua = axesOf(turnA);
  const ub = axesOf(turnB);
  const d: Point = [b[0] - a[0], b[1] - a[1]];
  // How far a box reaches along `n`: each half along its own axis, projected.
  const reach = (
    axes: Point[],
    half: readonly [number, number],
    n: Point
  ): number =>
    axes.reduce(
      (sum, axis, k) =>
        sum + (half[k] ?? 0) * Math.abs(axis[0] * n[0] + axis[1] * n[1]),
      0
    );
  for (const n of [...ua, ...ub]) {
    const gap = Math.abs(d[0] * n[0] + d[1] * n[1]);
    if (gap > reach(ua, halfA, n) + reach(ub, halfB, n)) {
      return false;
    }
  }
  return true;
}

/** Grid cells, chart units, for finding what lies near a point. */
const CELL = 8;

/** Things filed by the grid cell of a point, found again from the cells round a point. */
function gridOf<T>(): {
  add: (p: Point, item: T) => void;
  near: (p: Point) => T[];
} {
  const cells = new Map<string, T[]>();
  const keyOf = (cx: number, cz: number) => `${cx},${cz}`;
  return {
    add(p, item) {
      const key = keyOf(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL));
      const list = cells.get(key) ?? [];
      list.push(item);
      cells.set(key, list);
    },
    near(p) {
      const cx = Math.floor(p[0] / CELL);
      const cz = Math.floor(p[1] / CELL);
      const out: T[] = [];
      for (let i = -1; i <= 1; i += 1) {
        for (let j = -1; j <= 1; j += 1) {
          out.push(...(cells.get(keyOf(cx + i, cz + j)) ?? []));
        }
      }
      return out;
    },
  };
}

/** The stretches of a side to wall, as fractions along it: all of a back or a side; a front less its gate. */
function spansOf(
  side: Side,
  building: Building | undefined
): [number, number][] {
  if (!side.front) {
    return [[0, 1]];
  }
  const [g0, g1] = gateOf(side, building);
  const spans: [number, number][] = [];
  if (g0 > 0.05) {
    spans.push([0, g0]);
  }
  if (g1 < 0.95) {
    spans.push([g1, 1]);
  }
  return spans;
}

/** A side's run: its length, its direction, and its normal into the parcel. */
function runOf(
  side: Side,
  centre: Point
): { dir: Point; length: number; normal: Point } {
  const dx = side.b[0] - side.a[0];
  const dz = side.b[1] - side.a[1];
  const length = Math.hypot(dx, dz);
  const dir: Point = [dx / length, dz / length];
  const mid: Point = [(side.a[0] + side.b[0]) / 2, (side.a[1] + side.b[1]) / 2];
  // Inward: whichever normal points at the parcel's middle.
  const normal: Point = [-dir[1], dir[0]];
  const inward =
    (centre[0] - mid[0]) * normal[0] + (centre[1] - mid[1]) * normal[1] >= 0;
  return { dir, length, normal: inward ? normal : [-normal[0], -normal[1]] };
}

/** One stretch of a side cut into pieces of at most `PIECE`, each set in from the side by its own half thickness. */
function piecesAlong(
  side: Side,
  run: { dir: Point; length: number; normal: Point },
  [t0, t1]: [number, number],
  style: Style,
  height: number
): EdgePiece[] {
  const { dir, length, normal } = run;
  const inset = style.thick / 2 + INSET;
  // Its local x along the side: local x lands on (cos, sin).
  const turn = Math.atan2(dir[1], dir[0]);
  const stretch = (t1 - t0) * length;
  const count = Math.max(Math.ceil(stretch / PIECE), 1);
  const step = stretch / count;
  const half: readonly [number, number] = [step / 2, style.thick / 2];
  return Array.from({ length: count }, (_, k) => {
    const along = t0 * length + step * (k + 0.5);
    return {
      at: [
        side.a[0] + dir[0] * along + normal[0] * inset,
        side.a[1] + dir[1] * along + normal[1] * inset,
      ] as Point,
      part: style.part(half, height),
      turn,
    };
  });
}

interface EdgeContext {
  readonly blocked: (
    at: Point,
    turn: number,
    half: readonly [number, number]
  ) => boolean;
  readonly building: Building | undefined;
  readonly laid: ReturnType<typeof gridOf<Laid>>;
  readonly road: Road | undefined;
}

/** One parcel's edge: its sides not already walled, cut into pieces clear of the buildings. */
function parcelPieces(
  parcel: Parcel,
  style: Style,
  context: EdgeContext
): EdgePiece[] {
  const tall = parcel.edge === "fence" && TALL_FENCE.has(parcel.kind);
  const height = tall ? TALL_FENCE_HEIGHT : style.height;
  const count = parcel.outline.length;
  const centre: Point = [
    parcel.outline.reduce((sum, p) => sum + p[0], 0) / count,
    parcel.outline.reduce((sum, p) => sum + p[1], 0) / count,
  ];
  const pieces: EdgePiece[] = [];
  for (const side of sidesOf(parcel, context.road)) {
    const mid: Point = [
      (side.a[0] + side.b[0]) / 2,
      (side.a[1] + side.b[1]) / 2,
    ];
    const run = runOf(side, centre);
    if (run.length < 0.2 || shared(context.laid.near(mid), side.a, side.b)) {
      continue;
    }
    context.laid.add(mid, { dir: run.dir, half: run.length / 2, mid });
    const lift = side.front ? height * 0.8 : height;
    for (const span of spansOf(side, context.building)) {
      for (const piece of piecesAlong(side, run, span, style, lift)) {
        if (!context.blocked(piece.at, piece.turn, piece.part.half)) {
          pieces.push(piece);
        }
      }
    }
  }
  return pieces;
}

/** Every parcel's edge, as pieces on the chart, none cutting into a building. */
export function edgePieces(
  parcels: readonly Parcel[],
  roads: readonly Road[],
  buildings: readonly Building[]
): EdgePiece[] {
  const buildingOfParcel = new Map<number, Building>();
  const standing = gridOf<Building>();
  for (const b of buildings) {
    if (!buildingOfParcel.has(b.parcel)) {
      buildingOfParcel.set(b.parcel, b);
    }
    standing.add(b.at, b);
  }
  const blocked = (at: Point, turn: number, half: readonly [number, number]) =>
    standing
      .near(at)
      .some((b) => boxesOverlap(at, turn, half, b.at, b.turn, b.half));
  const laid = gridOf<Laid>();
  const pieces: EdgePiece[] = [];
  for (const parcel of parcels) {
    if (parcel.edge === "none" || parcel.outline.length < 3) {
      continue;
    }
    pieces.push(
      ...parcelPieces(parcel, STYLES[parcel.edge], {
        blocked,
        building: buildingOfParcel.get(parcel.id),
        laid,
        road: parcel.road === null ? undefined : roads[parcel.road],
      })
    );
  }
  return pieces;
}
