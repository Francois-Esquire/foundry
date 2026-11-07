/**
 * How the world planner (world-plan.ts) grows a town (REFERENCES.md
 * section 2, after Emilien et al.): the package root's street through the
 * plaza at the plateau's heart, then each folder's street grown from its
 * parent's as a least-cost walk, its lots claimed along the frontage in
 * the street's order, its branches' mouths kept free for them, and a loop
 * closed where its end comes near another road.
 *
 * A walk steps a unit at a time. At each step it weighs a fan of gentle
 * turns: how far each strays from the street's own wind (smooth noise
 * keyed by its folder's path, so it bends where nothing else makes it),
 * whether it runs too long straight, and what lies ahead (the sea's
 * margin, other roads, claimed ground, room for lots on both sides).
 * Anything it may not cross ends it.
 */
import type { Point } from "../../../data/chart";
import { cellAt, FREE } from "./town-land";
import type { BuildingKind, ParcelKind } from "./world";
import { ROAD_WIDTH } from "./world";
import {
  add,
  angleBetween,
  boundsOf,
  distance,
  dot,
  hashText,
  heading,
  isStraight,
  leftOf,
  longestStraight,
  noise1,
  normalise,
  pointAt,
  rectangle,
  scale,
  sub,
  unit,
  unitOf,
} from "./world-plan-geometry";
import {
  addParcel,
  clearAt,
  extendRoad,
  KERB,
  newRoad,
  type ParcelDraft,
  parcelFits,
  type RoadDraft,
  roadGap,
  type Skip,
  segmentClearOfParcels,
  stampFree,
  stampRoad,
  type Town,
  takenAt,
  trimRoad,
  unstamp,
} from "./world-plan-town";
import {
  type FolderNode,
  type Ground,
  groundKindOf,
  type Household,
  householdOf,
  type Unit,
} from "./world-plan-tree";

// ------------------------------------------------------------- the sizes

/** What a building takes along its street, and how it stands on its lot. */
export interface Footprint {
  readonly depth: number;
  readonly frontage: number;
  /** The building's half sizes: across (along the road) and deep. */
  readonly half: readonly [number, number];
  readonly parcel: ParcelKind;
  /** How far its front stands back from the lot's front. */
  readonly setback: number;
}

const HOUSE: Footprint = {
  depth: 3.5,
  frontage: 2.6,
  half: [1, 1.125],
  parcel: "lot",
  setback: 0.6,
};

/** A building's footprint and lot from its kind and flats a floor. */
export function footprintOf(kind: BuildingKind, flats: number): Footprint {
  switch (kind) {
    case "pair":
      return { ...HOUSE, frontage: 3.6, half: [1.5, 1.125] };
    case "walkup": {
      const across = 1.5 * flats + 0.7;
      return {
        depth: 4,
        frontage: across + 0.8,
        half: [across / 2, 1.25],
        parcel: "lot",
        setback: 0.9,
      };
    }
    case "block": {
      const across = 1.4 * flats + 0.6;
      return {
        depth: 5.2,
        frontage: across + 1.2,
        half: [across / 2, 1.6],
        parcel: "lot",
        setback: 1.2,
      };
    }
    case "tower":
      return {
        depth: 6.4,
        frontage: 6.2,
        half: [2.2, 2.2],
        parcel: "lot",
        setback: 1.2,
      };
    case "store":
      return {
        depth: 4.2,
        frontage: 4,
        half: [1.4, 1.1],
        parcel: "parking",
        setback: 1.7,
      };
    case "civic":
      return {
        depth: 4.6,
        frontage: 4.6,
        half: [1.8, 1.5],
        parcel: "lot",
        setback: 1,
      };
    case "station":
      return {
        depth: 4.4,
        frontage: 6.4,
        half: [2.6, 1.4],
        parcel: "lot",
        setback: 1,
      };
    case "utility":
      return {
        depth: 2,
        frontage: 1.8,
        half: [0.6, 0.6],
        parcel: "lot",
        setback: 0.4,
      };
    case "school":
      return {
        depth: 4.4,
        frontage: 7.4,
        half: [3.2, 1.4],
        parcel: "lot",
        setback: 1,
      };
    default:
      return HOUSE;
  }
}

/** A ground's size along and across its street, and its stand along the back. */
interface GroundSize {
  readonly depth: number;
  readonly frontage: number;
  readonly parcel: ParcelKind;
  /** The stand's half sizes. */
  readonly stand: readonly [number, number];
}

const GROUND_SIZES: Readonly<Record<string, GroundSize>> = {
  pitch: { depth: 7.2, frontage: 9, parcel: "pitch", stand: [2, 0.5] },
  playground: {
    depth: 4.2,
    frontage: 4.2,
    parcel: "playground",
    stand: [0.6, 0.25],
  },
  stadium: { depth: 12, frontage: 16, parcel: "track", stand: [6, 0.85] },
  track: { depth: 9.5, frontage: 13, parcel: "track", stand: [4, 0.6] },
};
/** A town with fewer buildings than this can't carry a stadium, nor this a track. */
const STADIUM_TOWN = 120;
const TRACK_TOWN = 60;

/** A ground's size and the smaller ones it may make do with, biggest first. */
export function groundSizesOf(
  tests: number,
  townBuildings: number
): GroundSize[] {
  const first = groundSizeOf(tests, townBuildings);
  const ladder = [
    GROUND_SIZES.stadium,
    GROUND_SIZES.track,
    GROUND_SIZES.pitch,
    GROUND_SIZES.playground,
  ];
  const from = ladder.indexOf(first);
  return ladder
    .slice(Math.max(from, 0))
    .filter((size): size is GroundSize => size !== undefined);
}

export function groundSizeOf(tests: number, townBuildings: number): GroundSize {
  let kind: string = groundKindOf(tests);
  if (kind === "stadium" && townBuildings < STADIUM_TOWN) {
    kind = "track";
  }
  if (kind === "track" && townBuildings < TRACK_TOWN) {
    kind = "pitch";
  }
  return GROUND_SIZES[kind] ?? (GROUND_SIZES.pitch as GroundSize);
}

// ---------------------------------------------------------------- walking

const STEP = 1;
/** The sharpest a street turns in a step: a radius of about 8 units. */
const MAX_TURN = 0.12;
const TURNS = 2;
/** How hard a street's own wind bends it, radians a unit, and over how long it changes. */
const WIND = 0.07;
const WIND_SPAN = 7;
/** How slowly the side a forced bend goes to swings over. */
const SWAY_SPAN = 18;
/** Past this many units without a bend, going straight on costs. */
/** Every stretch this long must bend at least this far off its chord (see `straightCost`). */
const BEND_SPAN = 15;
const BEND_DEPTH = 1;
/** Where a stretch first starts to cost for running straight. */
const EASE_SPAN = 10;
/** What `straightCost` says for a step that would leave a stretch too long and straight. */
const STRAIGHT_BLOCK = 50;
/** The longest straight stretch a loop may leave. */
const STRAIGHT_MAX = 18;
const LOOK = 5;
const FAR = [7, 10, 14, 18];
/** How hard a street far out is turned back along the town rather than out of it. */
const GATHER = 0.6;
/** Gap a road keeps from other roads' edges, and from ground it may not cross. */
const ROAD_GAP = 0.6;

/** A street's walk so far, kept so it can carry on later. */
export interface Walker {
  /** The heading it leans toward once out of its mouth, for its first stretch. */
  readonly aim: number;
  angle: number;
  readonly seed: number;
  readonly skip: Skip;
  /** Units still to walk before it may turn (out of its parent's lots). */
  straight: number;
  walked: number;
}

/** How long a street keeps leaning toward its aim. */
const AIM_SPAN = 10;

export function newWalker(
  name: string,
  angle: number,
  skip: Skip,
  straight: number,
  aim = angle
): Walker {
  return { aim, angle, seed: hashText(name), skip, straight, walked: 0 };
}

/** Whether a road may step from `from` to `to`, by the hard rules. */
function mayStep(
  town: Town,
  road: RoadDraft,
  walker: Walker,
  from: Point,
  to: Point
): boolean {
  const half = road.width / 2;
  if (clearAt(town.land, to) < town.land.margin + half + 0.25) {
    return false;
  }
  if (!segmentClearOfParcels(town, from, to, half + KERB)) {
    return false;
  }
  const reach = half + ROAD_WIDTH.main / 2 + ROAD_GAP;
  const skip: Skip = (other, seg) =>
    walker.skip(other, seg) ||
    (other.id === road.id &&
      (other.cum[seg + 1] ?? 0) > (road.cum.at(-1) ?? 0) - (road.width + 2.5));
  // Inside its mouth a street may pass close by a neighbour's mouth, never onto it.
  const gap = walker.straight > 0 ? 0.15 : ROAD_GAP;
  return roadGap(town, to, reach, skip) >= half + gap;
}

/** What lies ahead along a heading: the sea, taken ground, room for lots. */
function aheadCost(
  town: Town,
  road: RoadDraft,
  from: Point,
  dir: Point
): number {
  const { land } = town;
  const half = road.width / 2;
  const near = land.margin + half + 0.4;
  const [du, dv] = dir;
  let cost = 0;
  for (let i = 1; i <= LOOK; i += 1) {
    const u = from[0] + du * i * STEP;
    const v = from[1] + dv * i * STEP;
    const weight = 1 / i;
    const cell = cellAt(land, u, v);
    if (cell < 0 || (land.clear[cell] ?? 0) < near) {
      cost += 4 * weight;
    }
    if (cell < 0 || land.taken[cell] !== FREE) {
      cost += 3 * weight;
    }
    for (const reach of [half + 1.75, half + 3.5, -half - 1.75, -half - 3.5]) {
      const side = cellAt(land, u - dv * reach, v + du * reach);
      if (
        side < 0 ||
        (land.clear[side] ?? 0) < land.margin ||
        land.taken[side] !== FREE
      ) {
        cost += 0.3 * weight;
      }
    }
  }
  // The coast further ahead, so a street bends away before it gets there.
  for (const far of FAR) {
    if (
      clearAt(land, [from[0] + du * far, from[1] + dv * far]) <
      land.margin + half + 3
    ) {
      cost += 16 / far;
    }
  }
  // A pull to keep the town gathered: past halfway out, heading further out costs.
  const out = distance(from, town.centre) / Math.max(town.radius, 1);
  if (out > 0.5) {
    const radial = normalise(sub(from, town.centre));
    cost += GATHER * (out - 0.5) * Math.max(0, radial[0] * du + radial[1] * dv);
  }
  return cost;
}

/**
 * What going on to `to` costs for straightness (rule 6). A stretch of
 * chord `BEND_SPAN` must stray more than `BEND_DEPTH` from its chord: then
 * no stretch longer than about `BEND_SPAN` can stay within half a unit of
 * its own, since any such stretch holds one of chord `BEND_SPAN` that
 * strays at most twice that. Only the few points that far back are read.
 */
function straightCost(road: RoadDraft, to: Point): number {
  const { points } = road;
  const last = points.length - 1;
  let cost = 0;
  for (let i = last; i >= 0; i -= 1) {
    const d = distance(points[i] as Point, to);
    if (d > BEND_SPAN + 1.5) {
      break;
    }
    if (d >= BEND_SPAN && isStraight(points, i, last, to, BEND_DEPTH)) {
      return STRAIGHT_BLOCK;
    }
    if (
      d >= EASE_SPAN &&
      d < EASE_SPAN + 1.5 &&
      isStraight(points, i, last, to, BEND_DEPTH)
    ) {
      cost = 1.5;
    }
  }
  return cost;
}

/**
 * Which way the road must bend now, +1 or -1, or 0 when it need not: when
 * the stretch ending here has run straight long enough, it turns the way
 * a slow sway says, which keeps one side for twenty units or so, so bends
 * build into arcs that swing from side to side rather than wiggles that
 * cancel out or circles that close on themselves.
 */
function mustBend(road: RoadDraft, walker: Walker): number {
  const { points } = road;
  const last = points.length - 1;
  const end = points[last] as Point;
  for (let i = last - 1; i >= 0; i -= 1) {
    const start = points[i] as Point;
    const d = distance(start, end);
    if (d > EASE_SPAN + 1) {
      return 0;
    }
    if (d >= EASE_SPAN - 2 && isStraight(points, i, last, undefined, 0.7)) {
      return noise1(walker.seed + 1, walker.walked / SWAY_SPAN) >= 0 ? 1 : -1;
    }
  }
  return 0;
}

/** Sharper turns a blocked street may take, an elbow at a time. */
const ESCAPES = [0.3, -0.3, 0.5, -0.5, 0.7, -0.7];

/** The cheapest next heading among `turns` that the hard rules allow, or null when all are blocked. */
function bestTurn(
  town: Town,
  road: RoadDraft,
  walker: Walker,
  turns: readonly number[],
  extra: number
): { angle: number; cost: number } | null {
  const from = road.points.at(-1) as Point;
  const wind = WIND * noise1(walker.seed, walker.walked / WIND_SPAN);
  const bend = mustBend(road, walker);
  const options: { angle: number; cost: number }[] = [];
  for (const turn of turns) {
    const angle = walker.angle + turn;
    let cost = extra + 60 * (turn - wind) * (turn - wind);
    if (bend !== 0 && turn * bend < MAX_TURN * 0.6) {
      cost += 4;
    }
    if (walker.walked < AIM_SPAN) {
      const off = angleBetween(walker.aim, angle);
      cost += 3 * off * off;
    }
    const dir = heading(angle);
    const straight = straightCost(road, add(from, scale(dir, STEP)));
    if (straight >= STRAIGHT_BLOCK) {
      // Too long straight and no bend open: the street may not go this way at all.
      continue;
    }
    cost += straight;
    cost += aheadCost(town, road, add(from, scale(dir, STEP)), dir);
    options.push({ angle, cost });
  }
  // Cheapest first; the hard rules are dearer to test, so only until one passes.
  options.sort((a, b) => a.cost - b.cost);
  for (const option of options) {
    const to = add(from, scale(heading(option.angle), STEP));
    if (mayStep(town, road, walker, from, to)) {
      return option;
    }
  }
  return null;
}

/** Walks a road on by up to `length` units; returns how far it went. */
export function walk(
  town: Town,
  road: RoadDraft,
  walker: Walker,
  length: number
): number {
  let gone = 0;
  while (gone < length - 1e-6) {
    const from = road.points.at(-1) as Point;
    const limit = walker.straight > 0 ? MAX_TURN / 4 : MAX_TURN;
    const fan: number[] = [];
    for (let k = -TURNS; k <= TURNS; k += 1) {
      fan.push((k / TURNS) * limit);
    }
    const best =
      bestTurn(town, road, walker, fan, 0) ??
      bestTurn(town, road, walker, ESCAPES, 3);
    if (!best) {
      break;
    }
    const to = add(from, scale(heading(best.angle), STEP));
    extendRoad(town, road, to);
    walker.angle = best.angle;
    walker.walked += STEP;
    walker.straight = Math.max(0, walker.straight - STEP);
    gone += STEP;
  }
  return gone;
}

// ------------------------------------------------------------ the frontage

type Side = 1 | -1;

/** Where a street's next lot on one side may begin, going one way along it. */
interface Cursor {
  /** +1 toward the road's end, -1 toward its start (the root's far half). */
  readonly dir: Side;
  readonly from: number;
  /** How much of the road's end lots leave free, so it can still turn as it grows on. */
  lead: number;
  /** How many lots it has placed. */
  lots: number;
  s: number;
  readonly side: Side;
}

/** A rectangle along a road: its frame and outline. */
export interface Plot {
  readonly axis: Point;
  readonly face: Point;
  readonly half: readonly [number, number];
  readonly middle: Point;
  readonly outline: Point[];
}

const OFFSETS = [0, 0.3, 0.7, 1.2, 1.8];

/** A rectangle fronting a road between arclengths s0 and s1 on one side, if it fits. */
export function plotAlong(
  town: Town,
  road: RoadDraft,
  s0: number,
  s1: number,
  side: Side,
  depth: number,
  tries = OFFSETS.length
): Plot | null {
  const { at, tangent } = pointAt(road.points, road.cum, (s0 + s1) / 2);
  const normal = scale(leftOf(tangent), side);
  const frontage = Math.abs(s1 - s0);
  for (const offset of OFFSETS.slice(0, tries)) {
    const middle = add(
      at,
      scale(normal, road.width / 2 + KERB + offset + depth / 2)
    );
    if (takenAt(town.land, middle) !== FREE) {
      continue;
    }
    const outline = rectangle(middle, tangent, frontage / 2, depth / 2);
    if (parcelFits(town, outline)) {
      return {
        axis: tangent,
        face: scale(normal, -1),
        half: [frontage / 2, depth / 2],
        middle,
        outline,
      };
    }
  }
  return null;
}

const CURSOR_STEP = 0.5;

/** The first plot of a frontage from a cursor on, if any fits before the road ends. */
function plotFrom(
  town: Town,
  road: RoadDraft,
  cursor: Cursor,
  frontage: number,
  depth: number
): { plot: Plot; s: number } | null {
  const total = road.cum.at(-1) ?? 0;
  const { dir, lead, side, s: from } = cursor;
  for (let s = from; ; s += CURSOR_STEP * dir) {
    const s0 = dir > 0 ? s : s - frontage;
    const s1 = dir > 0 ? s + frontage : s;
    if (s0 < 0.2 || s1 > total - lead) {
      return null;
    }
    const plot = plotAlong(town, road, s0, s1, side, depth);
    if (plot) {
      return { plot, s: dir > 0 ? s1 : s0 };
    }
  }
}

/** How far apart lots stand: close in the middle, loosening toward the edge (rule 8). */
function gapAfter(town: Town, at: Point, name: string): number {
  const out = distance(at, town.centre) / Math.max(town.radius, 1);
  const loose = Math.max(0, Math.min(1, (out - 0.45) / 0.55));
  return loose * (0.4 + 1.4 * unitOf(name, 3));
}

/** A building stood on a plot: set back from its front, facing its road. */
function standOn(
  town: Town,
  parcel: ParcelDraft,
  plot: Plot,
  kind: BuildingKind,
  files: string[],
  storeys: number,
  half: readonly [number, number],
  setback: number
) {
  const hx = Math.min(half[0], plot.half[0] - 0.05);
  const hz = Math.min(half[1], plot.half[1] - 0.05);
  const back = Math.min(setback, plot.half[1] * 2 - hz * 2 - 0.05);
  const front = add(plot.middle, scale(plot.face, plot.half[1]));
  const at = sub(front, scale(plot.face, back + hz));
  town.buildings.push({
    at,
    face: plot.face,
    files,
    half: [hx, hz],
    kind,
    parcel: parcel.id,
    storeys,
  });
}

/** What a lot is walled with, by its kind and a hash of its first file. */
function edgeOf(kind: BuildingKind, name: string): ParcelDraft["edge"] {
  const roll = unitOf(name, 11);
  if (kind === "house" || kind === "pair") {
    if (roll < 0.6) {
      return "wall";
    }
    return roll < 0.9 ? "hedge" : "none";
  }
  if (kind === "walkup" || kind === "block" || kind === "tower") {
    return roll < 0.5 ? "wall" : "none";
  }
  return kind === "utility" || kind === "school" ? "fence" : "none";
}

/** What a street could not hold, to place elsewhere. */
export interface Leftover {
  /** The road it was meant for. */
  readonly road: number;
  readonly unit: Unit;
}

/** A branch's mouth kept free on its parent's frontage. */
export interface Mouth {
  /** The soft keep-out ahead of it, stamped on the land until it grows. */
  readonly keepOut: Point[];
  readonly node: FolderNode;
  /** The street whose turn grows it: the one whose units it belongs to, or -1 when moved later. */
  readonly owner: number;
  readonly reserve: ParcelDraft;
  readonly road: number;
  readonly s: number;
  /** The side it leaves from, or 0 when it carries on from the road's end. */
  readonly side: Side | 0;
}

/** Everything the island's streets share while they grow. */
export interface Growth {
  readonly leftovers: Leftover[];
  readonly mouths: Mouth[];
  /** The test group that gets the island's school, by key, or null. */
  readonly school: string | null;
  /** How many buildings the town has, to size its grounds. */
  readonly townBuildings: number;
}

/** Claims a building's lot from a cursor; false when none fits. */
function placeBuilding(
  town: Town,
  road: RoadDraft,
  cursor: Cursor,
  home: Household,
  name: string
): boolean {
  const fp = footprintOf(home.kind, home.flats);
  const found = plotFrom(town, road, cursor, fp.frontage, fp.depth);
  if (!found) {
    return false;
  }
  commitBuilding(town, road.id, found.plot, home, name);
  cursor.s = found.s + cursor.dir * gapAfter(town, found.plot.middle, name);
  // Every few lots a lane's width is left open, where a street that finds
  // no other room may branch off later.
  cursor.lots += 1;
  if (cursor.lots % SPARE_EVERY === 0 && road.rank !== "path") {
    cursor.s += cursor.dir * SPARE_GAP;
  }
  return true;
}

const SPARE_EVERY = 6;
const SPARE_GAP = ROAD_WIDTH.lane + 2 * KERB + 1.4;

export function commitBuilding(
  town: Town,
  road: number | null,
  plot: Plot,
  home: Household,
  name: string
) {
  const fp = footprintOf(home.kind, home.flats);
  const parcel = addParcel(town, {
    axis: plot.axis,
    edge: edgeOf(home.kind, name),
    face: plot.face,
    half: plot.half,
    kind: fp.parcel,
    middle: plot.middle,
    outline: plot.outline,
    road,
  });
  standOn(
    town,
    parcel,
    plot,
    home.kind,
    home.files.map((m) => m.id),
    home.storeys,
    fp.half,
    fp.setback
  );
}

/** Claims a ground and its stand (and the school beside the biggest). */
function placeGround(
  town: Town,
  road: RoadDraft,
  cursor: Cursor,
  ground: Ground,
  growth: Growth,
  size: GroundSize
): boolean {
  const found = plotFrom(town, road, cursor, size.frontage, size.depth);
  if (!found) {
    return false;
  }
  commitGround(town, road.id, found.plot, ground, size);
  cursor.s = found.s + cursor.dir * 0.6;
  if (growth.school === ground.key) {
    const school = householdOf("school", []);
    const fp = footprintOf("school", 0);
    const next = plotFrom(town, road, cursor, fp.frontage, fp.depth);
    if (next) {
      commitBuilding(town, road.id, next.plot, school, `${ground.key}/school`);
      cursor.s = next.s + cursor.dir * 0.4;
    }
  }
  return true;
}

export function commitGround(
  town: Town,
  road: number | null,
  plot: Plot,
  ground: Ground,
  size: GroundSize
) {
  const parcel = addParcel(town, {
    axis: plot.axis,
    edge: size.parcel === "playground" ? "hedge" : "fence",
    face: plot.face,
    half: plot.half,
    kind: size.parcel,
    middle: plot.middle,
    outline: plot.outline,
    road,
  });
  // The stand runs along the ground's back, its seats facing the pitch and the road.
  const back = sub(
    plot.middle,
    scale(plot.face, plot.half[1] - size.stand[1] - 0.15)
  );
  town.buildings.push({
    at: back,
    face: plot.face,
    files: ground.files.map((m) => m.id),
    half: [Math.min(size.stand[0], plot.half[0] - 0.2), size.stand[1]],
    kind: "stand",
    parcel: parcel.id,
    storeys: 0,
  });
}

/** How much room lies ahead of a point along a direction: free buildable cells in a band. */
function roomToward(town: Town, at: Point, dir: Point, from: number): number {
  let room = 0;
  for (let d = from; d < from + 23; d += 1.5) {
    for (const along of [-3, 0, 3]) {
      const u = at[0] + dir[0] * d - dir[1] * along;
      const v = at[1] + dir[1] * d + dir[0] * along;
      if (takenAt(town.land, [u, v]) === FREE) {
        room += 1;
      }
    }
  }
  return room;
}

/** How much room a side of a road has ahead of `s`. */
function roomOn(town: Town, road: RoadDraft, s: number, side: Side): number {
  const { at, tangent } = pointAt(road.points, road.cum, s);
  return roomToward(town, at, scale(leftOf(tangent), side), road.width / 2 + 1);
}

/** How far a street could run straight from a point before the coast or claimed ground. */
function freeRun(
  town: Town,
  at: Point,
  dir: Point,
  from: number,
  max: number
): number {
  for (let d = from; d < max; d += 1) {
    const p = add(at, scale(dir, d));
    if (
      clearAt(town.land, p) < town.land.margin + 3 ||
      takenAt(town.land, p) !== FREE
    ) {
      return d - from;
    }
  }
  return max - from;
}

/** The heading a new street leans toward: near its slant, toward the most open land. */
function aimFrom(
  town: Town,
  at: Point,
  out: Point,
  slant: number,
  from: number
): number {
  const base = Math.atan2(out[1], out[0]);
  let best = base + slant;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const turn of [-0.8, -0.4, 0, 0.4, 0.8]) {
    const angle = base + turn;
    const run = freeRun(town, at, heading(angle), from, from + 30);
    const off = angleBetween(base + slant, angle);
    const score = Math.min(run, 14) - 6 * off * off;
    if (score > bestScore) {
      bestScore = score;
      best = angle;
    }
  }
  return best;
}

/** How deep ahead of a mouth other streets are asked to keep off. */
const KEEP_OUT = 12;
const MOUTH_DEPTH = 5;

/** Keeps a mouth's corridor: a reserved parcel at its start, a soft keep-out beyond. */
function keepMouth(
  town: Town,
  road: RoadDraft,
  node: FolderNode,
  plot: Plot,
  s: number,
  side: Side | 0,
  owner: number
): Mouth {
  const reserve = addParcel(town, {
    axis: plot.axis,
    edge: "none",
    face: plot.face,
    half: plot.half,
    kind: "reserve",
    middle: plot.middle,
    outline: plot.outline,
    road: road.id,
  });
  const ahead = scale(plot.face, -(KEEP_OUT - MOUTH_DEPTH) / 2);
  const keepOut = rectangle(
    add(plot.middle, ahead),
    plot.axis,
    plot.half[0],
    KEEP_OUT / 2
  );
  stampFree(town.land, keepOut, reserve.id);
  return { keepOut, node, owner, reserve, road: road.id, s, side };
}

/** Keeps a branch's mouth free; false when no side has room for it. */
function placeMouth(
  town: Town,
  road: RoadDraft,
  cursors: readonly Cursor[],
  node: FolderNode,
  growth: Growth
): boolean {
  const width = mouthWidth(node);
  const ranked = cursors
    .map((cursor) => ({
      cursor,
      room: roomOn(
        town,
        road,
        cursor.s + (cursor.dir * width) / 2,
        cursor.side
      ),
    }))
    .sort((a, b) => b.room - a.room)
    .map(({ cursor }) => cursor);
  for (const cursor of ranked) {
    const found = plotFrom(town, road, cursor, width, MOUTH_DEPTH);
    if (!found) {
      continue;
    }
    const s = found.s - (cursor.dir * width) / 2;
    growth.mouths.push(
      keepMouth(town, road, node, found.plot, s, cursor.side, road.id)
    );
    cursor.s = found.s + cursor.dir * 0.3;
    return true;
  }
  return false;
}

const mouthWidth = (node: FolderNode): number =>
  ROAD_WIDTH[node.rank] + 2 * KERB + 1.2;

/** Enough room to grow a street into, out of the samples `roomOn` takes. */
const ROOMY = 18;

/**
 * A new mouth for a branch that could not grow from its own: the roomiest
 * free stretch of frontage along its parent's road or, failing that, the
 * nearest road with room.
 */
export function moveMouth(
  town: Town,
  mouth: Mouth,
  growth: Growth
): Mouth | null {
  const parent = town.roads[mouth.road] as RoadDraft;
  const origin = pointAt(parent.points, parent.cum, mouth.s).at;
  return findMouth(town, mouth.node, origin, growth);
}

/** A mouth for a street with the most room near `origin`, along the nearest roads that have any. */
function findMouth(
  town: Town,
  node: FolderNode,
  origin: Point,
  growth: Growth,
  owner = -1
): Mouth | null {
  const width = mouthWidth(node);
  // A street of a few lots needs less open land ahead than a long one.
  const roomy = Math.min(ROOMY, 6 + 2 * node.units.length);
  const roads = [...town.roads]
    .filter((r) => r.points.length > 1 && r.rank !== "path")
    .sort((a, b) => nearestTo(a, origin) - nearestTo(b, origin));
  for (const road of roads) {
    const best = roomiestMouth(town, road, width, roomy);
    if (best) {
      const moved = keepMouth(
        town,
        road,
        node,
        best.plot,
        best.s,
        best.side,
        owner
      );
      growth.mouths.push(moved);
      return moved;
    }
  }
  return null;
}

interface MouthSpot {
  readonly plot: Plot;
  readonly room: number;
  readonly s: number;
  readonly side: Side | 0;
}

/** The roomiest place along one road a mouth fits: a side, or an end it carries on from. */
function roomiestMouth(
  town: Town,
  road: RoadDraft,
  width: number,
  roomy: number
): MouthSpot | null {
  let best: MouthSpot | null = null;
  const total = road.cum.at(-1) ?? 0;
  for (let s = 0.5; s + width < total - 0.5; s += 2.5) {
    for (const side of [1, -1] as const) {
      const sofar: number = best === null ? 0 : (best as MouthSpot).room + 1;
      best =
        sideMouth(town, road, s, side, width, Math.max(roomy, sofar)) ?? best;
    }
  }
  // A road's ends can carry on too: its far end, and the root's near one.
  for (const start of road.parent === null ? [false, true] : [false]) {
    const end = endMouth(town, road, width, start);
    if (end && end.room >= roomy && (!best || end.room > best.room)) {
      best = { plot: end.plot, room: end.room, s: start ? 0 : total, side: 0 };
    }
  }
  return best;
}

/** A mouth on one side at arclength `s`, if it fits and has at least `least` room ahead. */
function sideMouth(
  town: Town,
  road: RoadDraft,
  s: number,
  side: Side,
  width: number,
  least: number
): MouthSpot | null {
  const room = roomOn(town, road, s + width / 2, side);
  if (room < least) {
    return null;
  }
  const plot = plotAlong(town, road, s, s + width, side, MOUTH_DEPTH, 2);
  return plot ? { plot, room, s: s + width / 2, side } : null;
}

/** A mouth carrying a road on from its end, with the room ahead of it, if it fits. */
function endMouth(
  town: Town,
  road: RoadDraft,
  width: number,
  start: boolean
): { plot: Plot; room: number } | null {
  const total = road.cum.at(-1) ?? 0;
  const { at, tangent: along } = pointAt(
    road.points,
    road.cum,
    start ? 0 : total
  );
  const tangent = start ? scale(along, -1) : along;
  const lateral = leftOf(tangent);
  const middle = add(
    at,
    scale(tangent, road.width / 2 + KERB + MOUTH_DEPTH / 2)
  );
  // Its rectangle runs across the road's end: x along the road's normal, z back toward it.
  const outline = rectangle(middle, lateral, width / 2, MOUTH_DEPTH / 2);
  if (!parcelFits(town, outline)) {
    return null;
  }
  const room = roomToward(town, at, tangent, road.width / 2 + 1);
  const plot: Plot = {
    axis: lateral,
    face: scale(tangent, -1),
    half: [width / 2, MOUTH_DEPTH / 2],
    middle,
    outline,
  };
  return { plot, room };
}

function nearestTo(road: RoadDraft, p: Point): number {
  let best = Number.POSITIVE_INFINITY;
  for (const q of road.points) {
    best = Math.min(best, distance(p, q));
  }
  return best;
}

/** The cursor that has gone least far, ties by the unit's hash. */
function nextCursors(cursors: readonly Cursor[], name: string): Cursor[] {
  const flip = unitOf(name, 5) < 0.5;
  return [...cursors].sort((a, b) => {
    const d = Math.abs(a.s - a.from) - Math.abs(b.s - b.from);
    if (Math.abs(d) > 0.5) {
      return d;
    }
    return flip ? b.side - a.side : a.side - b.side;
  });
}

/** Places one unit along a road from the least advanced cursor that fits it. */
function placeUnit(
  town: Town,
  road: RoadDraft,
  cursors: readonly Cursor[],
  item: Unit,
  growth: Growth
): boolean {
  if (item.kind === "branch") {
    return placeMouth(town, road, cursors, item.node, growth);
  }
  const order = nextCursors(cursors, item.name);
  if (item.kind === "ground") {
    // A ground that fits nowhere at its size makes do a size smaller.
    for (const size of groundSizesOf(
      item.ground.files.length,
      growth.townBuildings
    )) {
      if (
        order.some((cursor) =>
          placeGround(town, road, cursor, item.ground, growth, size)
        )
      ) {
        return true;
      }
    }
    return false;
  }
  if (item.home.kind === "block" && !inCore(town, road, order)) {
    return placeSplit(town, road, order, item, growth);
  }
  return order.some((cursor) =>
    placeBuilding(town, road, cursor, item.home, item.name)
  );
}

/** How far from the plaza, as a share of the town's reach, the dense core runs: where blocks may stand (rule 5). */
export const CORE_REACH = 0.6;

/** Whether the next lot along a street (its least advanced cursor) would stand in the core. */
function inCore(
  town: Town,
  road: RoadDraft,
  order: readonly Cursor[]
): boolean {
  const [cursor] = order;
  if (!cursor) {
    return false;
  }
  const { at } = pointAt(road.points, road.cum, cursor.s);
  return distance(at, town.centre) <= town.radius * CORE_REACH;
}

/**
 * A block that would stand outside the core is built as walk-ups instead,
 * side by side: the street still builds up, just not as high. What does
 * not fit is left for later like any other unit.
 */
function placeSplit(
  town: Town,
  road: RoadDraft,
  order: readonly Cursor[],
  item: Extract<Unit, { kind: "building" }>,
  growth: Growth
): boolean {
  const { files } = item.home;
  const parts = Math.ceil(files.length / WALKUP_MOST);
  for (let k = 0; k < parts; k += 1) {
    const from = Math.floor((k * files.length) / parts);
    const share = files.slice(
      from,
      Math.floor(((k + 1) * files.length) / parts)
    );
    const home = householdOf("walkup", share);
    if (
      !order.some((cursor) =>
        placeBuilding(town, road, cursor, home, share[0]?.id ?? item.name)
      )
    ) {
      // No room for walk-ups side by side: what is left stays one building.
      const rest = files.slice(from);
      const kind = rest.length >= BLOCK_LEAST ? "block" : "walkup";
      const merged: Extract<Unit, { kind: "building" }> = {
        home: householdOf(kind, rest),
        kind: "building",
        name: rest[0]?.id ?? item.name,
      };
      if (
        order.some((cursor) =>
          placeBuilding(town, road, cursor, merged.home, merged.name)
        )
      ) {
        return true;
      }
      growth.leftovers.push({ road: road.id, unit: merged });
      return true;
    }
  }
  return true;
}

const BLOCK_LEAST = 9;

const WALKUP_MOST = 8;

/** How long a street must be to hold its units on both sides. */
function lengthFor(units: readonly Unit[], growth: Growth): number {
  let frontage = 0;
  for (const item of units) {
    if (item.kind === "building") {
      frontage += footprintOf(item.home.kind, item.home.flats).frontage + 0.4;
    } else if (item.kind === "ground") {
      frontage +=
        groundSizeOf(item.ground.files.length, growth.townBuildings).frontage +
        0.6;
    } else {
      frontage += ROAD_WIDTH[item.node.rank] + 1;
    }
  }
  return frontage / 2 + 2;
}

/** Lays a street's units along it, walking it on when it runs out. */
function fillStreet(
  town: Town,
  road: RoadDraft,
  walker: Walker | null,
  cursors: Cursor[],
  units: readonly Unit[],
  growth: Growth
) {
  const setLead = (lead: number) => {
    for (const cursor of cursors) {
      cursor.lead = lead;
    }
  };
  setLead(walker ? LEAD : END_LEAD);
  const early = reserveMouths(town, road, cursors, units, growth);
  for (const item of units) {
    if (early.has(item)) {
      continue;
    }
    let placed = placeUnit(town, road, cursors, item, growth);
    for (let tries = 0; !placed && walker && tries < 3; tries += 1) {
      if (walk(town, road, walker, 4) <= 0) {
        // The street can go no further: use its end too.
        setLead(END_LEAD);
        placed = placeUnit(town, road, cursors, item, growth);
        break;
      }
      placed = placeUnit(town, road, cursors, item, growth);
    }
    if (!placed) {
      leave(town, road, item, growth);
    }
  }
}

/**
 * Keeps the mouths of a street's branches before any lot is laid, spread
 * along it in the street's order, each on the side with more room, so lots
 * fill in round the junctions rather than leaving none. Returns the
 * branches it kept a mouth for.
 */
function reserveMouths(
  town: Town,
  road: RoadDraft,
  cursors: readonly Cursor[],
  units: readonly Unit[],
  growth: Growth
): Set<Unit> {
  const kept = new Set<Unit>();
  const total = road.cum.at(-1) ?? 0;
  const runs = cursors.filter((c) => c.side === 1);
  let branchIndex = 0;
  for (const [index, item] of units.entries()) {
    if (item.kind !== "branch") {
      continue;
    }
    const run = runs[branchIndex % runs.length] as Cursor;
    branchIndex += 1;
    const length = run.dir > 0 ? total - LEAD - run.from : run.from - 0.5;
    const target = run.from + run.dir * length * ((index + 0.5) / units.length);
    if (keepMouthNear(town, road, item.node, target, growth)) {
      kept.add(item);
    }
  }
  return kept;
}

/** A mouth for a branch as near arclength `target` as one fits, on the roomier side first. */
function keepMouthNear(
  town: Town,
  road: RoadDraft,
  node: FolderNode,
  target: number,
  growth: Growth
): boolean {
  const width = mouthWidth(node);
  const total = road.cum.at(-1) ?? 0;
  const sides = ([1, -1] as const)
    .map((side) => ({ room: roomOn(town, road, target, side), side }))
    .sort((a, b) => b.room - a.room);
  for (const { side } of sides) {
    for (let k = 0; k < 2 * total; k += 1) {
      const s = target + (k % 2 === 0 ? k / 2 : -(k + 1) / 2);
      if (s - width / 2 < 0.3 || s + width / 2 > total - 0.3) {
        continue;
      }
      const plot = plotAlong(
        town,
        road,
        s - width / 2,
        s + width / 2,
        side,
        MOUTH_DEPTH,
        2
      );
      if (plot) {
        growth.mouths.push(keepMouth(town, road, node, plot, s, side, road.id));
        return true;
      }
    }
  }
  return false;
}

/** Road kept free of lots past the last one while a street may still grow, and once it can't. */
const LEAD = 3;
const END_LEAD = 0.2;

/** What a street could not hold: a branch looks for a mouth elsewhere, the rest wait. */
function leave(town: Town, road: RoadDraft, item: Unit, growth: Growth) {
  if (item.kind !== "branch") {
    growth.leftovers.push({ road: road.id, unit: item });
    return;
  }
  const end = road.points.at(-1) as Point;
  const found = findMouth(town, item.node, end, growth, road.id);
  if (found) {
    return;
  }
  for (const inner of flatten(item.node)) {
    growth.leftovers.push({ road: road.id, unit: inner });
  }
}

/** Cuts a street back to just past its last lot or mouth. */
function trimStreet(
  road: RoadDraft,
  cursors: readonly Cursor[],
  growth: Growth
) {
  let used = 2;
  for (const cursor of cursors) {
    if (cursor.dir > 0) {
      used = Math.max(used, cursor.s);
    }
  }
  for (const mouth of growth.mouths) {
    if (mouth.road === road.id) {
      used = Math.max(used, mouth.s + 1.5);
    }
  }
  trimRoad(road, used + 0.6);
}

/** Cursors for a street grown from its parent: both sides, from its mouth on. */
function streetCursors(start: number): Cursor[] {
  return [
    { dir: 1, from: start, lead: LEAD, lots: 0, s: start, side: 1 },
    { dir: 1, from: start, lead: LEAD, lots: 0, s: start, side: -1 },
  ];
}

/** Cursors for the root's street: both sides, both ways out from the plaza. */
function rootCursors(middle: number, half: number): Cursor[] {
  return [
    {
      dir: 1,
      from: middle + half,
      lead: LEAD,
      lots: 0,
      s: middle + half,
      side: 1,
    },
    {
      dir: 1,
      from: middle + half,
      lead: LEAD,
      lots: 0,
      s: middle + half,
      side: -1,
    },
    {
      dir: -1,
      from: middle - half,
      lead: LEAD,
      lots: 0,
      s: middle - half,
      side: 1,
    },
    {
      dir: -1,
      from: middle - half,
      lead: LEAD,
      lots: 0,
      s: middle - half,
      side: -1,
    },
  ];
}

// ------------------------------------------------------------------ loops

const LOOP_REACH = 12;
const LOOP_CONE = 0.6;
/** How many targets a street's end tries before it stays a dead end. */
const LOOP_TRIES = 10;

/**
 * Closes a loop: when a street's end comes within reach of another road
 * ahead of it, it runs on to meet that road's centreline (Emilien's cycle
 * step).
 */
function closeLoop(town: Town, road: RoadDraft) {
  const n = road.points.length;
  if (n < 3) {
    return;
  }
  const end = road.points[n - 1] as Point;
  const dir = normalise(sub(end, road.points[n - 2] as Point));
  for (const target of targetsAhead(town, road, end, dir).slice(
    0,
    LOOP_TRIES
  )) {
    const points = connector(town, road, end, target);
    if (!points) {
      continue;
    }
    const keep = road.points.length;
    for (const p of points) {
      extendRoad(town, road, p);
    }
    if (
      longestStraight(road.points, Math.max(0, keep - 24)) <=
      STRAIGHT_MAX + 1
    ) {
      return;
    }
    road.points = road.points.slice(0, keep);
    road.cum = road.cum.slice(0, keep);
  }
}

interface LoopTarget {
  readonly at: Point;
  readonly road: number;
  readonly seg: number;
}

/**
 * Points on other roads' centrelines within reach ahead of a street's end
 * and meeting them well across, nearest first.
 */
function targetsAhead(
  town: Town,
  road: RoadDraft,
  end: Point,
  dir: Point
): LoopTarget[] {
  const out: { target: LoopTarget; gap: number }[] = [];
  const centre = add(end, scale(dir, LOOP_REACH / 2));
  for (const near of town.roadIndex.near(
    boundsOf([centre], LOOP_REACH / 2 + 1)
  )) {
    const other = town.roads[near.road];
    if (!other || other.id === road.id || near.seg + 1 >= other.points.length) {
      continue;
    }
    const a = other.points[near.seg] as Point;
    const b = other.points[near.seg + 1] as Point;
    const along = normalise(sub(b, a));
    for (const t of [0, 0.5]) {
      const at: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const to = sub(at, end);
      const gap = distance(at, end);
      const ahead = gap > 0 ? dot(to, dir) / gap : 0;
      const across = gap > 0 ? Math.abs(dot(along, to)) / gap : 1;
      if (
        gap >= 1.5 &&
        gap <= LOOP_REACH &&
        ahead >= LOOP_CONE &&
        across < 0.8
      ) {
        out.push({ gap, target: { at, road: other.id, seg: near.seg } });
      }
    }
  }
  out.sort(
    (x, y) =>
      x.gap - y.gap ||
      x.target.road - y.target.road ||
      x.target.seg - y.target.seg
  );
  return out.map(({ target }) => target);
}

/** The straight run from a street's end to a point on another road, if it passes clear; else null. */
function connector(
  town: Town,
  road: RoadDraft,
  end: Point,
  target: LoopTarget
): Point[] | null {
  const other = town.roads[target.road] as RoadDraft;
  const steps = Math.max(1, Math.ceil(distance(end, target.at) / STEP));
  let from = end;
  const points: Point[] = [];
  for (let k = 1; k <= steps; k += 1) {
    const t = k / steps;
    const p: Point = [
      end[0] + (target.at[0] - end[0]) * t,
      end[1] + (target.at[1] - end[1]) * t,
    ];
    const nearTarget =
      distance(p, target.at) < other.width / 2 + road.width / 2 + 1.2;
    const skip: Skip = (r, seg) =>
      r.id === road.id ||
      (nearTarget && r.id === other.id && Math.abs(seg - target.seg) <= 2);
    const blocked =
      !segmentClearOfParcels(town, from, p, road.width / 2 + KERB) ||
      clearAt(town.land, p) < town.land.margin + road.width / 2 ||
      (!nearTarget && roadGap(town, p, 3, skip) < road.width / 2 + ROAD_GAP);
    if (blocked) {
      return null;
    }
    points.push(p);
    from = p;
  }
  return points;
}

// --------------------------------------------------------------- the root

/** Grows the root's street through the heart, both ways, with the plaza and the station at its middle. */
export function growRoot(
  town: Town,
  node: FolderNode,
  station: Household | null,
  growth: Growth
): RoadDraft {
  const angle = (unit(town.seed, 1) - 0.5) * 0.6;
  const length = lengthFor(node.units, growth) + 4;
  const road = newRoad(town, town.centre, node.rank, node.path, null);
  const back = newWalker(`${node.path}#back`, angle + Math.PI, () => false, 0);
  walk(town, road, back, length / 2);
  // Turn the first half round so the road runs through the heart.
  const reversed = [...road.points].reverse();
  town.roads.pop();
  const root = newRoad(town, reversed[0] as Point, node.rank, node.path, null);
  for (const p of reversed.slice(1)) {
    extendRoad(town, root, p);
  }
  const middle = root.cum.at(-1) ?? 0;
  const ahead = newWalker(`${node.path}#ahead`, angle, () => false, 0);
  walk(town, root, ahead, length / 2);
  const plaza = 3.2;
  placePlaza(town, root, middle, plaza, station, growth);
  const cursors = rootCursors(middle, plaza + 0.2);
  fillStreet(town, root, ahead, cursors, node.units, growth);
  trimRoot(root, cursors, growth);
  stampRoad(town.land, root);
  return root;
}

function trimRoot(road: RoadDraft, cursors: readonly Cursor[], growth: Growth) {
  let used = 0;
  for (const cursor of cursors) {
    if (cursor.dir > 0) {
      used = Math.max(used, cursor.s);
    }
  }
  for (const mouth of growth.mouths) {
    if (mouth.road === road.id) {
      used = Math.max(used, mouth.s + 1.5);
    }
  }
  trimRoad(road, used + 0.6);
}

/** The station's lot: across from the plaza if it fits, else the nearest that does, either side. */
function stationSpot(
  town: Town,
  road: RoadDraft,
  middle: number,
  fp: Footprint
): Plot | null {
  for (let k = 0; k <= STATION_SEARCH; k += 1) {
    const s = middle + (k % 2 === 0 ? k / 2 : -(k + 1) / 2);
    for (const side of [-1, 1] as const) {
      const plot = plotAlong(
        town,
        road,
        s - fp.frontage / 2,
        s + fp.frontage / 2,
        side,
        fp.depth
      );
      if (plot) {
        return plot;
      }
    }
  }
  return null;
}

/** How many unit steps from the plaza the station looks for its lot. */
const STATION_SEARCH = 24;

/** The plaza on one side of the root's middle and the station across from it. */
function placePlaza(
  town: Town,
  road: RoadDraft,
  middle: number,
  half: number,
  station: Household | null,
  growth: Growth
) {
  const plot = plotAlong(town, road, middle - half, middle + half, 1, 5.5);
  if (plot) {
    addParcel(town, {
      axis: plot.axis,
      edge: "none",
      face: plot.face,
      half: plot.half,
      kind: "plaza",
      middle: plot.middle,
      outline: plot.outline,
      road: road.id,
    });
  }
  if (station) {
    const fp = footprintOf("station", 0);
    const name = station.files[0]?.id ?? "station";
    const spot = stationSpot(town, road, middle, fp);
    if (spot) {
      commitBuilding(town, road.id, spot, station, name);
    } else {
      growth.leftovers.push({
        road: road.id,
        unit: { home: station, kind: "building", name },
      });
    }
  }
}

// ------------------------------------------------------------ the branches

/** Grows a branch's street from its mouth, fills it, and closes a loop if one is near. */
export function growBranch(
  town: Town,
  mouth: Mouth,
  growth: Growth
): RoadDraft | null {
  mouth.reserve.alive = false;
  unstamp(town.land, mouth.keepOut, mouth.reserve.id);
  const parent = town.roads[mouth.road] as RoadDraft;
  const { at, tangent } = pointAt(parent.points, parent.cum, mouth.s);
  const along = mouth.s <= 0 ? scale(tangent, -1) : tangent;
  const normal = mouth.side === 0 ? along : scale(leftOf(tangent), mouth.side);
  // Lanes leave their parent at a slant, mostly leaning on outward, toward open land.
  const lean = mouth.side === 0 ? 0 : -0.3 + 1.2 * unitOf(mouth.node.path, 7);
  const slant = -Math.atan(lean) * mouth.side;
  const aim = aimFrom(town, at, normal, slant, parent.width / 2 + MOUTH_DEPTH);
  const angle = Math.atan2(normal[1], normal[0]);
  const folder = mouth.node.path.endsWith(MORE)
    ? mouth.node.path.slice(0, -MORE.length)
    : mouth.node.path;
  const road = newRoad(town, at, mouth.node.rank, folder || null, parent.id);
  const near = parent.width / 2 + 2.5;
  const skip: Skip = (other, seg) =>
    other.id === parent.id &&
    (other.cum[seg + 1] ?? 0) > mouth.s - near &&
    (other.cum[seg] ?? 0) < mouth.s + near;
  const out = parent.width / 2 + 4;
  const walker = newWalker(mouth.node.path, angle, skip, out, aim);
  const length = lengthFor(mouth.node.units, growth) + parent.width / 2;
  const walked = walk(town, road, walker, Math.max(length, out + 1));
  if (walked < Math.min(length, parent.width / 2 + 3)) {
    dropRoad(town, road);
    // The mouth stays kept, empty, so no other street tries it again.
    mouth.reserve.alive = true;
    return null;
  }
  const cursors = streetCursors(parent.width / 2 + KERB + 0.1);
  const before = growth.leftovers.length;
  fillStreet(town, road, walker, cursors, mouth.node.units, growth);
  trimStreet(road, cursors, growth);
  closeLoop(town, road);
  stampRoad(town.land, road);
  if (!mouth.node.path.endsWith(MORE)) {
    overflow(town, road, before, growth);
  }
  return road;
}

/** The most units one overflow lane is asked to hold. */
const LANE_UNITS = 6;

/** The mark on an overflow lane's folder node, so it makes no overflow of its own. */
const MORE = "#more";

/**
 * What a street could not hold gets a lane of its own, branching where
 * there is room near the street: the same folder, carried on.
 */
function overflow(town: Town, road: RoadDraft, before: number, growth: Growth) {
  const mine = growth.leftovers.splice(before);
  if (mine.length === 0) {
    return;
  }
  const end = road.points.at(-1) as Point;
  if (!findMouth(town, overflowNode(road.folder, mine), end, growth, road.id)) {
    growth.leftovers.push(...mine);
  }
}

/** A lane's worth of leftovers as a folder node of their own street, carried on. */
function overflowNode(
  folder: string | null,
  mine: readonly Leftover[]
): FolderNode {
  return {
    children: [],
    depth: 3,
    files: mine.flatMap((left) =>
      left.unit.kind === "building" ? left.unit.home.files : []
    ),
    grounds: [],
    homes: [],
    path: `${folder ?? ""}${MORE}`,
    rank: "lane",
    specials: [],
    units: mine.map((left) => left.unit),
  };
}

/**
 * The last chance for leftovers: each street's gets an overflow lane from
 * wherever there is room nearest it, grown at once. Returns what still
 * found no place.
 */
export function rehouse(town: Town, growth: Growth): Leftover[] {
  const byRoad = new Map<number, Leftover[]>();
  for (const left of growth.leftovers.splice(0)) {
    const list = byRoad.get(left.road) ?? [];
    list.push(left);
    byRoad.set(left.road, list);
  }
  // Short lanes, a few lots each, find room where one long one would not.
  const lanes: [number, Leftover[]][] = [];
  for (const [id, all] of byRoad) {
    for (let k = 0; k < all.length; k += LANE_UNITS) {
      lanes.push([id, all.slice(k, k + LANE_UNITS)]);
    }
  }
  const still: Leftover[] = [];
  for (const [id, mine] of lanes) {
    const road = town.roads[id];
    const origin = road?.points.at(-1) ?? town.centre;
    const mouth = findMouth(
      town,
      overflowNode(road?.folder ?? null, mine),
      origin,
      growth
    );
    const grown = mouth ? growBranch(town, mouth, growth) : null;
    if (!grown) {
      still.push(...mine);
    }
    // What the overflow lane itself could not hold waits for the last resort.
    still.push(...growth.leftovers.splice(0));
  }
  return still;
}

/** Takes the newest road back off (it grew too short to hold anything). */
function dropRoad(town: Town, road: RoadDraft) {
  road.points = [road.points[0] as Point];
  road.cum = [0];
  if (town.roads.at(-1) === road) {
    town.roads.pop();
  }
}

/** All of a folder's units below and including it, for a branch that found no room. */
export function flatten(node: FolderNode): Unit[] {
  const out: Unit[] = [];
  for (const item of node.units) {
    if (item.kind === "branch") {
      out.push(...flatten(item.node));
    } else {
      out.push(item);
    }
  }
  return out;
}
