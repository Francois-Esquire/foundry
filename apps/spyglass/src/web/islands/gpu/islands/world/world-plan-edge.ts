import type { Module, Point, Polygon } from "../../../data/chart";
import { CELL, FREE, type Land } from "./town-land";
import { ROAD_WIDTH } from "./world";
import {
  add,
  boundsOf,
  convexHull,
  distance,
  dot,
  heading,
  insideConvex,
  leftOf,
  normalise,
  pointAt,
  rectangle,
  SpatialIndex,
  scale,
  sub,
  unit,
} from "./world-plan-geometry";
import {
  CORE_REACH,
  newWalker,
  type Plot,
  plotAlong,
  walk,
} from "./world-plan-grow";
import {
  addParcel,
  type BuildingDraft,
  clearAt,
  KERB,
  nearestRoadPoint,
  newRoad,
  type ParcelDraft,
  parcelFits,
  pathToRoad,
  type RoadDraft,
  resample,
  roadGap,
  segmentClearOfParcels,
  smoothPath,
  stampRoad,
  type Town,
} from "./world-plan-town";

const BOATHOUSE_FILES = 3;
const BOAT_FRONTAGE = 2.4;
const BOAT_DEPTH = 3.2;
const BOAT_HALF: readonly [number, number] = [1, 1.35];
const PATH_REACH = 30;
const PATH_WIDTH = ROAD_WIDTH.path;

class Halo {
  readonly cells: Uint8Array;
  readonly land: Land;

  constructor(land: Land) {
    this.land = land;
    this.cells = new Uint8Array(land.cols * land.rows);
  }

  add(parcel: Pick<ParcelDraft, "middle" | "axis" | "half">, pad: number) {
    const { land } = this;
    const ring = rectangle(
      parcel.middle,
      parcel.axis,
      parcel.half[0] + pad,
      parcel.half[1] + pad
    );
    const box = boundsOf(ring);
    const i0 = Math.max(0, Math.floor((box.minU - land.u0) / CELL));
    const i1 = Math.min(land.cols - 1, Math.floor((box.maxU - land.u0) / CELL));
    const j0 = Math.max(0, Math.floor((box.minV - land.v0) / CELL));
    const j1 = Math.min(land.rows - 1, Math.floor((box.maxV - land.v0) / CELL));
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const p: Point = [
          land.u0 + (i + 0.5) * CELL,
          land.v0 + (j + 0.5) * CELL,
        ];
        if (insideConvex(ring, p)) {
          this.cells[j * land.cols + i] = 1;
        }
      }
    }
  }
}

const HALO_PAD = 0.6;

function footpath(town: Town, halo: Halo, from: Point): Point[] | null {
  const walk0 = pathToRoad(town, from, halo.cells, PATH_REACH);
  if (!walk0 || walk0.length < 2) {
    return null;
  }
  const line = smoothPath(walk0);
  const near = nearestRoadPoint(town, line[0] as Point, 2.5);
  if (!near) {
    return null;
  }
  const start = near.at;
  const points = [start, ...line.filter((p) => distance(p, start) > 1)];
  const fine = resample(points, 1);
  for (let k = 0; k + 1 < fine.length; k += 1) {
    const a = fine[k] as Point;
    const b = fine[k + 1] as Point;
    if (!segmentClearOfParcels(town, a, b, PATH_WIDTH / 2 + KERB)) {
      return null;
    }
    if (clearAt(town.land, b) < town.land.margin) {
      return null;
    }
  }
  return fine;
}

function addPath(
  town: Town,
  points: readonly Point[],
  parent: number | null
): RoadDraft {
  const road = newRoad(town, points[0] as Point, "path", null, parent);
  for (const p of points.slice(1)) {
    extend(town, road, p);
  }
  stampRoad(town.land, road);
  return road;
}

function extend(town: Town, road: RoadDraft, p: Point) {
  const last = road.points.at(-1) as Point;
  if (distance(last, p) > 1e-6) {
    road.points.push(p);
    road.cum.push((road.cum.at(-1) ?? 0) + distance(last, p));
    town.roadIndex.insert(boundsOf([last, p], road.width / 2), {
      road: road.id,
      seg: road.points.length - 2,
    });
  }
}

function emptiness(land: Land): Float32Array {
  const { cols, rows } = land;
  const far = new Float32Array(cols * rows);
  for (let cell = 0; cell < far.length; cell += 1) {
    far[cell] = land.taken[cell] === FREE ? 1e9 : 0;
  }
  const diagonal = CELL * Math.SQRT2;
  const relax = (k: number, other: number, step: number) => {
    const through = (far[other] as number) + step;
    if (through < (far[k] as number)) {
      far[k] = through;
    }
  };
  for (let j = 1; j < rows - 1; j += 1) {
    for (let k = j * cols + 1; k < (j + 1) * cols - 1; k += 1) {
      relax(k, k - 1, CELL);
      relax(k, k - cols, CELL);
      relax(k, k - cols - 1, diagonal);
      relax(k, k - cols + 1, diagonal);
    }
  }
  for (let j = rows - 2; j > 0; j -= 1) {
    for (let k = (j + 1) * cols - 2; k > j * cols; k -= 1) {
      relax(k, k + 1, CELL);
      relax(k, k + cols, CELL);
      relax(k, k + cols + 1, diagonal);
      relax(k, k + cols - 1, diagonal);
    }
  }
  return far;
}

const cellMiddle = (land: Land, cell: number): Point => [
  land.u0 + ((cell % land.cols) + 0.5) * CELL,
  land.v0 + (Math.floor(cell / land.cols) + 0.5) * CELL,
];

const SHRINE_HALF: readonly [number, number] = [2.5, 2.5];
const GROVE_RADIUS = 8;
const SHRINE_CLEAR = GROVE_RADIUS + 8;
const SHRINE_TRIES = 6;

function placeShrine(town: Town, halo: Halo, far: Float32Array) {
  const score = shrineScores(town.land, far);
  const tried: Point[] = [];
  for (let attempt = 0; attempt < SHRINE_TRIES; attempt += 1) {
    const cell = bestSite(town.land, score, tried);
    if (cell < 0) {
      return;
    }
    const at = cellMiddle(town.land, cell);
    tried.push(at);
    if (
      shrineAt(town, halo, at, Math.min(GROVE_RADIUS, (far[cell] ?? 0) + 2))
    ) {
      return;
    }
  }
}

function shrineScores(land: Land, far: Float32Array): Float32Array {
  const score = new Float32Array(far.length).fill(Number.NEGATIVE_INFINITY);
  for (let cell = 0; cell < far.length; cell += 1) {
    const empty = far[cell] ?? 0;
    const clear = land.clear[cell] ?? 0;
    if (empty >= 4 && empty <= 22 && clear >= land.margin + 4) {
      score[cell] =
        Math.min(empty, 10) +
        0.5 * Math.min(clear - land.margin, 8) -
        0.05 * empty;
    }
  }
  return score;
}

function bestSite(
  land: Land,
  score: Float32Array,
  tried: readonly Point[]
): number {
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let cell = 0; cell < score.length; cell += 1) {
    const value = score[cell] ?? Number.NEGATIVE_INFINITY;
    if (
      value > bestScore &&
      !tried.some((p) => distance(p, cellMiddle(land, cell)) < 8)
    ) {
      best = cell;
      bestScore = value;
    }
  }
  return best;
}

function shrineAt(town: Town, halo: Halo, at: Point, radius: number): boolean {
  const face = normalise(sub(town.centre, at));
  const axis: Point = [face[1], -face[0]];
  const outline = rectangle(at, axis, SHRINE_HALF[0], SHRINE_HALF[1]);
  if (!parcelFits(town, outline)) {
    return false;
  }
  const parcel = addParcel(town, {
    axis,
    edge: "hedge",
    face,
    half: SHRINE_HALF,
    kind: "shrine",
    middle: at,
    outline,
    road: null,
  });
  const path = footpath(town, halo, add(at, scale(face, SHRINE_HALF[1] + 1.2)));
  if (!path) {
    parcel.alive = false;
    return false;
  }
  const road = addPath(
    town,
    path,
    nearestRoadPoint(town, path[0] as Point, 0.1)?.road ?? null
  );
  parcel.road = road.id;
  halo.add(parcel, HALO_PAD);
  town.buildings.push({
    at: sub(at, scale(face, 0.6)),
    face,
    files: [],
    half: [1, 1.25],
    kind: "shrine",
    parcel: parcel.id,
    storeys: 1,
  });
  grove(town, at, face, radius, road);
  return true;
}

function grove(
  town: Town,
  at: Point,
  face: Point,
  radius: number,
  path: RoadDraft
) {
  const middle = sub(at, scale(face, radius * 0.35));
  const ring: Point[] = [];
  for (let k = 0; k < 20; k += 1) {
    const a = (k / 20) * 2 * Math.PI;
    const wobble = 1 + 0.12 * (unit(town.seed, 41, k) - 0.5);
    ring.push(add(middle, scale(heading(a), radius * wobble)));
  }
  town.zones.push({ kind: "grove", outline: ring });
  const spacing = 1.6;
  for (let u = -radius; u <= radius; u += spacing) {
    for (let v = -radius; v <= radius; v += spacing) {
      const jitter: Point = [
        (unit(town.seed, 43, Math.round(u * 10), Math.round(v * 10)) - 0.5) *
          spacing *
          0.8,
        (unit(town.seed, 47, Math.round(u * 10), Math.round(v * 10)) - 0.5) *
          spacing *
          0.8,
      ];
      const p = add(add(middle, [u, v]), jitter);
      if (distance(p, middle) > radius * 0.92 || !openGround(town, p, 0.9)) {
        continue;
      }
      if (
        roadGap(town, p, 1.5) < 0.6 &&
        nearestRoadPoint(town, p, 1.5)?.road === path.id
      ) {
        continue;
      }
      town.trees.push({
        at: p,
        kind: "grove",
        size:
          0.8 +
          0.5 * unit(town.seed, 53, Math.round(u * 10), Math.round(v * 10)),
      });
    }
  }
}

function openGround(town: Town, p: Point, gap: number): boolean {
  if (clearAt(town.land, p) < 1) {
    return false;
  }
  if (roadGap(town, p, gap + 1.5) < gap) {
    return false;
  }
  for (const id of town.parcelIndex.near(boundsOf([p], gap))) {
    const parcel = town.parcels[id] as ParcelDraft;
    if (
      parcel.alive &&
      parcel.kind !== "reserve" &&
      insideConvex(grown(parcel, gap * 0.5), p)
    ) {
      return false;
    }
  }
  return true;
}

const grown = (parcel: ParcelDraft, pad: number): Point[] =>
  rectangle(
    parcel.middle,
    parcel.axis,
    parcel.half[0] + pad,
    parcel.half[1] + pad
  );

interface Rim {
  readonly out: Point[];
  readonly points: Point[];
}

function rimOf(town: Town): Rim {
  const { land } = town;
  const middle = town.centre;
  const reach = Math.hypot(land.cols, land.rows) * CELL;
  const steps = 360;
  const points: Point[] = [];
  const out: Point[] = [];
  for (let k = 0; k < steps; k += 1) {
    const dir = heading((k / steps) * 2 * Math.PI);
    let found: Point | null = null;
    for (let r = reach; r > 0; r -= 2) {
      if (clearAt(land, add(middle, scale(dir, r))) >= land.margin + 0.3) {
        let edge = r;
        while (
          clearAt(land, add(middle, scale(dir, edge + CELL / 2))) >=
          land.margin + 0.3
        ) {
          edge += CELL / 2;
        }
        found = add(middle, scale(dir, edge));
        break;
      }
    }
    if (found) {
      points.push(found);
      out.push(dir);
    }
  }
  const normals = points.map((_, k) => {
    const prev = points[(k - 2 + points.length) % points.length] as Point;
    const next = points[(k + 2) % points.length] as Point;
    const t = normalise(sub(next, prev));
    const n: Point = [t[1], -t[0]];
    return dot(n, out[k] as Point) >= 0 ? n : scale(n, -1);
  });
  return { out: normals, points };
}

function bestStretch(
  rim: Rim,
  length: number,
  score: (k: number) => number
): { from: number; count: number } | null {
  const n = rim.points.length;
  let best: { from: number; count: number; score: number } | null = null;
  for (let from = 0; from < n; from += 3) {
    let run = 0;
    let total = 0;
    let count = 1;
    let smooth = true;
    while (run < length && count < n / 2) {
      const a = rim.points[(from + count - 1) % n] as Point;
      const b = rim.points[(from + count) % n] as Point;
      const step = distance(a, b);
      const turn = dot(
        rim.out[(from + count - 1) % n] as Point,
        rim.out[(from + count) % n] as Point
      );
      if (step > RIM_JUMP || turn < 0.8) {
        smooth = false;
        break;
      }
      run += step;
      total += score((from + count) % n);
      count += 1;
    }
    if (smooth && run >= length && (!best || total / count > best.score)) {
      best = { count, from, score: total / count };
    }
  }
  return best ? { count: best.count, from: best.from } : null;
}

const RIM_JUMP = 4;

const stretchPoints = (rim: Rim, from: number, count: number): Point[] =>
  Array.from(
    { length: count },
    (_, k) => rim.points[(from + k) % rim.points.length] as Point
  );

function placeShore(
  town: Town,
  halo: Halo,
  rim: Rim,
  far: Float32Array,
  files: readonly Module[]
) {
  const shrine = town.buildings.find((b) => b.kind === "shrine")?.at;
  if (files.length === 0 || rim.points.length < 8) {
    return { left: [...files], used: [] as number[] };
  }
  const houses = Math.ceil(files.length / BOATHOUSE_FILES);
  const length = houses * (BOAT_FRONTAGE + 0.15) * 1.4 + 3;
  const stretch = bestStretch(rim, length, (k) => {
    const p = rim.points[k] as Point;
    if (shrine && distance(p, shrine) < SHRINE_CLEAR) {
      return -20;
    }
    const cell =
      Math.floor((p[1] - town.land.v0) / CELL) * town.land.cols +
      Math.floor((p[0] - town.land.u0) / CELL);
    return Math.min(far[cell] ?? 0, 12);
  });
  if (!stretch) {
    return { left: [...files], used: [] as number[] };
  }
  const line = resample(stretchPoints(rim, stretch.from, stretch.count), 0.5);
  const cum = cumulative(line);
  const total = cum.at(-1) ?? 0;
  const placed: { parcel: ParcelDraft; plot: Plot }[] = [];
  const sea = rim.out[
    (stretch.from + Math.floor(stretch.count / 2)) % rim.points.length
  ] as Point;
  let s = 1;
  const groups = chunk(files, houses);
  const left: Module[] = [];
  for (const group of groups) {
    let done = false;
    while (!done && s + BOAT_FRONTAGE < total - 0.5) {
      const plot = boatPlot(town, line, cum, s, sea);
      if (plot) {
        const parcel = addParcel(town, {
          axis: plot.axis,
          edge: "none",
          face: plot.face,
          half: plot.half,
          kind: "lot",
          middle: plot.middle,
          outline: plot.outline,
          road: null,
        });
        halo.add(parcel, HALO_PAD);
        placed.push({ parcel, plot });
        town.buildings.push({
          at: plot.middle,
          face: plot.face,
          files: group.map((m) => m.id),
          half: [BOAT_HALF[0], BOAT_HALF[1]],
          kind: "boathouse",
          parcel: parcel.id,
          storeys: 2,
        });
        s += BOAT_FRONTAGE + 0.15;
        done = true;
      } else {
        s += 0.5;
      }
    }
    if (!done) {
      left.push(...group);
    }
  }
  shorePath(town, halo, placed);
  return { left, used: [stretch.from, stretch.count] };
}

function boatPlot(
  town: Town,
  line: readonly Point[],
  cum: readonly number[],
  s: number,
  sea: Point
): Plot | null {
  const { at, tangent } = pointAt(line, cum, s + BOAT_FRONTAGE / 2);
  const lateral = leftOf(tangent);
  const out = dot(lateral, sea) >= 0 ? lateral : scale(lateral, -1);
  for (const inset of [0, 0.4, 0.8, 1.2]) {
    const middle = sub(at, scale(out, BOAT_DEPTH / 2 + inset));
    const outline = rectangle(
      middle,
      tangent,
      BOAT_FRONTAGE / 2,
      BOAT_DEPTH / 2
    );
    if (parcelFits(town, outline)) {
      return {
        axis: tangent,
        face: out,
        half: [BOAT_FRONTAGE / 2, BOAT_DEPTH / 2],
        middle,
        outline,
      };
    }
  }
  return null;
}

function shorePath(
  town: Town,
  halo: Halo,
  placed: readonly { parcel: ParcelDraft; plot: Plot }[]
) {
  if (placed.length === 0) {
    return;
  }
  const behind = placed.map(({ plot }) =>
    sub(plot.middle, scale(plot.face, plot.half[1] + 0.55))
  );
  const first = behind[0] as Point;
  const last = behind.at(-1) as Point;
  const nearEnd = distance(first, town.centre) <= distance(last, town.centre);
  const row = nearEnd ? behind : [...behind].reverse();
  const lead = footpath(town, halo, row[0] as Point);
  const line = lead ? [...lead, ...row.slice(1)] : null;
  if (line) {
    const fine = resample(line, 1);
    let ok = true;
    for (let k = 0; k + 1 < fine.length && ok; k += 1) {
      ok = segmentClearOfParcels(
        town,
        fine[k] as Point,
        fine[k + 1] as Point,
        PATH_WIDTH / 2 + KERB
      );
    }
    if (ok) {
      const road = addPath(
        town,
        fine,
        nearestRoadPoint(town, fine[0] as Point, 0.1)?.road ?? null
      );
      for (const { parcel } of placed) {
        parcel.road = road.id;
      }
    }
  }
  const seaward = placed.map(({ plot }) =>
    add(plot.middle, scale(plot.face, plot.half[1] + 0.8))
  );
  const landward = placed.map(({ plot }) =>
    sub(plot.middle, scale(plot.face, plot.half[1] + 1.2))
  );
  town.zones.push({
    kind: "shore",
    outline: [...seaward, ...landward.reverse()],
  });
}

function cumulative(line: readonly Point[]): number[] {
  const out = [0];
  for (let k = 1; k < line.length; k += 1) {
    out.push(
      (out[k - 1] ?? 0) + distance(line[k - 1] as Point, line[k] as Point)
    );
  }
  return out;
}

function chunk(files: readonly Module[], n: number): Module[][] {
  const out: Module[][] = [];
  let k = 0;
  for (let g = 0; g < n; g += 1) {
    const size = Math.ceil((files.length - k) / (n - g));
    out.push(files.slice(k, k + size));
    k += size;
  }
  return out.filter((group) => group.length > 0);
}

function placeLighthouse(
  town: Town,
  rim: Rim,
  used: readonly number[],
  file: Module
): boolean {
  const n = rim.points.length;
  const order = rim.points
    .map((p, k) => ({ d: distance(p, town.centre), k }))
    .sort((a, b) => b.d - a.d || a.k - b.k);
  const [from, count] = used;
  for (const { k } of order.slice(0, 60)) {
    if (
      from !== undefined &&
      count !== undefined &&
      (k - from + n) % n < count + 20
    ) {
      continue;
    }
    const p = rim.points[k] as Point;
    const out = rim.out[k] as Point;
    const axis = leftOf(out);
    for (const inset of [1.2, 1.8, 2.6]) {
      const middle = sub(p, scale(out, inset));
      const outline = rectangle(middle, axis, 1.2, 1.2);
      if (!parcelFits(town, outline)) {
        continue;
      }
      const parcel = addParcel(town, {
        axis,
        edge: "none",
        face: scale(out, -1),
        half: [1.2, 1.2],
        kind: "lot",
        middle,
        outline,
        road: null,
      });
      town.buildings.push({
        at: middle,
        face: scale(out, -1),
        files: [file.id],
        half: [0.6, 0.6],
        kind: "lighthouse",
        parcel: parcel.id,
        storeys: 4,
      });
      return true;
    }
  }
  return false;
}

const FIELD_PATH = 16;

function placeFields(town: Town, halo: Halo, budget: number) {
  const ends = town.roads
    .filter(
      (road) =>
        road.rank !== "path" && road.points.length > 1 && !joined(town, road)
    )
    .map((road) => ({
      d: distance(road.points.at(-1) as Point, town.centre),
      road,
    }))
    .filter(({ d }) => d > town.radius * 0.45)
    .sort((a, b) => b.d - a.d || a.road.id - b.road.id);
  let area = 0;
  for (const { road } of ends) {
    if (area >= budget) {
      return;
    }
    area += farm(town, halo, road);
  }
}

function joined(town: Town, road: RoadDraft): boolean {
  const end = road.points.at(-1) as Point;
  const near = nearestRoadPoint(
    town,
    end,
    0.05,
    (other) => other.id === road.id
  );
  return near !== null;
}

function farm(town: Town, halo: Halo, from: RoadDraft): number {
  const n = from.points.length;
  const end = from.points[n - 1] as Point;
  const dir = normalise(sub(end, from.points[n - 2] as Point));
  const road = newRoad(town, end, "path", null, from.id);
  const skip = (other: RoadDraft, seg: number) =>
    other.id === from.id && seg >= from.points.length - 4;
  const walker = newWalker(
    `${from.folder ?? ""}#farm`,
    Math.atan2(dir[1], dir[0]),
    skip,
    1
  );
  walk(town, road, walker, FIELD_PATH);
  if ((road.cum.at(-1) ?? 0) < 6) {
    dropLast(town, road);
    return 0;
  }
  let area = 0;
  for (const side of [1, -1] as const) {
    let s = 1;
    while (s < (road.cum.at(-1) ?? 0) - 3) {
      const frontage =
        5 + 3 * unit(town.seed, 61, road.id, Math.round(s * 10), side);
      const depth =
        5 + 3 * unit(town.seed, 67, road.id, Math.round(s * 10), side);
      const plot = plotAlong(town, road, s, s + frontage, side, depth, 3);
      if (!plot) {
        s += 1;
        continue;
      }
      const parcel = addParcel(town, {
        axis: plot.axis,
        edge:
          unit(town.seed, 71, road.id, Math.round(s)) < 0.5 ? "hedge" : "none",
        face: plot.face,
        half: plot.half,
        kind: "field",
        middle: plot.middle,
        outline: plot.outline,
        road: road.id,
      });
      halo.add(parcel, HALO_PAD);
      town.zones.push({ kind: "field", outline: plot.outline });
      area += frontage * depth;
      s += frontage + 0.3;
    }
  }
  if (area === 0) {
    dropLast(town, road);
    return 0;
  }
  stampRoad(town.land, road);
  return area;
}

function dropLast(town: Town, road: RoadDraft) {
  road.points = [road.points[0] as Point];
  road.cum = [0];
  if (town.roads.at(-1) === road) {
    town.roads.pop();
  }
}

const GARDEN_DEPTH = 1.8;

function placeGardens(
  town: Town,
  buildingOf: ReadonlyMap<number, BuildingDraft>
) {
  for (const parcel of town.parcels) {
    const building = buildingOf.get(parcel.id);
    if (
      !(
        parcel.alive &&
        building &&
        (building.kind === "house" || building.kind === "pair")
      )
    ) {
      continue;
    }
    const middle = sub(
      parcel.middle,
      scale(parcel.face, parcel.half[1] + GARDEN_DEPTH / 2 + 0.05)
    );
    const outline = rectangle(
      middle,
      parcel.axis,
      parcel.half[0],
      GARDEN_DEPTH / 2
    );
    if (!parcelFits(town, outline)) {
      continue;
    }
    town.zones.push({ kind: "garden", outline });
    const roll = unit(town.seed, 73, parcel.id);
    if (roll < 0.34) {
      const across = (unit(town.seed, 79, parcel.id) - 0.5) * parcel.half[0];
      town.trees.push({
        at: add(middle, scale(parcel.axis, across)),
        kind: "garden",
        size: 0.55 + 0.25 * unit(town.seed, 83, parcel.id),
      });
    }
  }
}

function placePines(
  town: Town,
  rim: Rim,
  far: Float32Array,
  used: readonly number[]
) {
  const n = rim.points.length;
  let perimeter = 0;
  for (let k = 0; k < n; k += 1) {
    perimeter += distance(
      rim.points[k] as Point,
      rim.points[(k + 1) % n] as Point
    );
  }
  const [from, count] = used;
  const stretch = bestStretch(rim, Math.min(perimeter * 0.25, 70), (k) => {
    if (
      from !== undefined &&
      count !== undefined &&
      (k - from + n) % n < count + 10
    ) {
      return -20;
    }
    const p = rim.points[k] as Point;
    const cell =
      Math.floor((p[1] - town.land.v0) / CELL) * town.land.cols +
      Math.floor((p[0] - town.land.u0) / CELL);
    return Math.min(far[cell] ?? 0, 10);
  });
  if (!stretch) {
    return;
  }
  const inner: Point[] = [];
  const outer: Point[] = [];
  for (let k = 0; k < stretch.count; k += 1) {
    const index = (stretch.from + k) % n;
    const p = rim.points[index] as Point;
    const out = rim.out[index] as Point;
    inner.push(sub(p, scale(out, 1.5)));
    let lip = p;
    for (let d = 0.5; d <= town.land.margin; d += 0.5) {
      const q = add(p, scale(out, d));
      if (clearAt(town.land, q) < 1.2) {
        break;
      }
      lip = q;
    }
    outer.push(lip);
  }
  town.zones.push({
    kind: "pines",
    outline: [...outer, ...[...inner].reverse()],
  });
  for (let k = 0; k < stretch.count; k += 2) {
    const a = inner[k] as Point;
    const b = outer[k] as Point;
    for (const t of [0.25, 0.65, 0.95]) {
      const jitter = (unit(town.seed, 89, k, Math.round(t * 100)) - 0.5) * 1.2;
      const along = normalise(
        sub(
          rim.points[(stretch.from + k + 1) % n] as Point,
          rim.points[(stretch.from + k) % n] as Point
        )
      );
      const p = add(add(a, scale(sub(b, a), t)), scale(along, jitter));
      if (
        unit(town.seed, 97, k, Math.round(t * 100)) < 0.25 ||
        !openGround(town, p, 0.7)
      ) {
        continue;
      }
      town.trees.push({
        at: p,
        kind: "pine",
        size: 0.7 + 0.35 * unit(town.seed, 101, k, Math.round(t * 100)),
      });
    }
  }
}

function placeStreetTrees(town: Town, buildings: SpatialIndex<BuildingDraft>) {
  for (const road of town.roads) {
    if (road.rank !== "main" || road.points.length < 2) {
      continue;
    }
    const total = road.cum.at(-1) ?? 0;
    let side = unit(town.seed, 103, road.id) < 0.5 ? 1 : -1;
    for (let s = 3; s < total - 1; s += 6.5) {
      const { at, tangent } = pointAt(road.points, road.cum, s);
      const p = add(at, scale(leftOf(tangent), side * (road.width / 2 + 0.45)));
      side = -side;
      const size = 0.55 + 0.15 * unit(town.seed, 107, road.id, Math.round(s));
      if (
        clearOfBuildings(buildings, p, size + 0.15) &&
        roadGap(town, p, 2, (r) => r.id === road.id) > 0.4
      ) {
        town.trees.push({ at: p, kind: "street", size });
      }
    }
  }
}

function clearOfBuildings(
  buildings: SpatialIndex<BuildingDraft>,
  p: Point,
  gap: number
): boolean {
  for (const b of buildings.near(boundsOf([p], gap + 3))) {
    const axis: Point = [-b.face[1], b.face[0]];
    const ring = rectangle(b.at, axis, b.half[0] + gap, b.half[1] + gap);
    if (insideConvex(ring, p)) {
      return false;
    }
  }
  return true;
}

function placePoles(town: Town) {
  for (const road of town.roads) {
    if (road.rank === "path" || road.points.length < 2) {
      continue;
    }
    const total = road.cum.at(-1) ?? 0;
    const side = unit(town.seed, 109, road.id) < 0.5 ? 1 : -1;
    let s = 2 + 3 * unit(town.seed, 113, road.id);
    while (s < total - 0.5) {
      const { at, tangent } = pointAt(road.points, road.cum, s);
      const p = add(
        at,
        scale(leftOf(tangent), side * (road.width / 2 + KERB / 2))
      );
      if (roadGap(town, p, 2, (r) => r.id === road.id) > 0.3) {
        town.poles.push({ at: p, road: road.id });
      }
      s += 8 + 4 * unit(town.seed, 127, road.id, Math.round(s));
    }
  }
}

function placeCore(town: Town) {
  const reach = town.radius * CORE_REACH;
  const points: Point[] = [];
  for (const parcel of town.parcels) {
    if (
      !parcel.alive ||
      parcel.kind === "reserve" ||
      parcel.kind === "field" ||
      parcel.kind === "shrine"
    ) {
      continue;
    }
    if (distance(parcel.middle, town.centre) <= reach) {
      points.push(...parcel.outline);
    }
  }
  if (points.length >= 3) {
    town.zones.push({ kind: "core", outline: convexHull(points) });
  }
}

function meadowOf(land: Land, coast: Polygon): Point[] {
  return coast.outer.map(([x, y]) => {
    const dx = x - land.centre[0];
    const dy = y - land.centre[1];
    return [
      dx * land.cos + dy * land.sin,
      -dx * land.sin + dy * land.cos,
    ] as Point;
  });
}

export function finishEdge(
  town: Town,
  coast: Polygon,
  alone: readonly Module[],
  lost: readonly Module[]
) {
  const halo = new Halo(town.land);
  for (const parcel of town.parcels) {
    if (parcel.alive && parcel.kind !== "reserve") {
      halo.add(parcel, HALO_PAD);
    }
  }
  const far = emptiness(town.land);
  placeShrine(town, halo, far);
  const rim = rimOf(town);
  const shoreFiles = [...alone];
  const keeper = shoreFiles.length > 1 ? shoreFiles.pop() : undefined;
  shoreFiles.push(...lost);
  const shore = placeShore(town, halo, rim, far, shoreFiles);
  if (keeper && !placeLighthouse(town, rim, shore.used, keeper)) {
    shore.left.push(keeper);
  }
  if (shore.left.length > 0) {
    shelter(town, shore.left);
  }
  let buildable = 0;
  for (const clear of town.land.clear) {
    buildable += clear >= town.land.margin ? 1 : 0;
  }
  placeFields(town, halo, buildable * CELL * CELL * 0.12);
  const buildingOf = new Map(town.buildings.map((b) => [b.parcel, b] as const));
  placeGardens(town, buildingOf);
  placePines(town, rim, far, shore.used);
  const buildings = new SpatialIndex<BuildingDraft>();
  for (const b of town.buildings) {
    buildings.insert(boundsOf([b.at], Math.max(b.half[0], b.half[1])), b);
  }
  placeStreetTrees(town, buildings);
  placePoles(town);
  placeCore(town);
  town.zones.unshift({ kind: "meadow", outline: meadowOf(town.land, coast) });
}

function shelter(town: Town, files: readonly Module[]) {
  const boats = town.buildings.filter((b) => b.kind === "boathouse");
  const homes = town.buildings.filter(
    (b) => b.kind !== "stand" && b.kind !== "shrine" && b.kind !== "school"
  );
  const hosts = boats.length > 0 ? boats : homes;
  for (const [k, m] of files.entries()) {
    const host = hosts[k % Math.max(hosts.length, 1)] ?? town.buildings[0];
    if (host) {
      host.files.push(m.id);
      if (host.kind === "boathouse") {
        host.storeys = Math.max(
          host.storeys,
          1 + Math.ceil(host.files.length / 2)
        );
      }
    }
  }
}
