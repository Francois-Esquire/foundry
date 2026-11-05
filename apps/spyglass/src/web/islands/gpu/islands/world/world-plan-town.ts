/**
 * One island's town while the world planner (world-plan.ts) grows it: the
 * roads, parcels and buildings so far, in the island's own frame
 * (town-land.ts), with the checks every new piece must pass. Roads and
 * parcels are tested exactly against each other through a spatial index;
 * the land grid carries only the soft fields (how far the sea is, what
 * ground is taken) that the growth steers by.
 */
import type { Import, Point } from "../../../data/chart";
import { CELL, cellAt, FREE, type Land, STREET } from "./town-land";
import type {
	BuildingKind,
	ParcelKind,
	PlannedTree,
	RoadRank,
	ZoneKind,
} from "./world";
import { ROAD_WIDTH } from "./world";
import {
	arclengths,
	type Bounds,
	boundsOf,
	boxesNear,
	convexOverlap,
	distance,
	insideConvex,
	nearestOnSegment,
	noise2,
	SpatialIndex,
	segmentDistance,
	segmentPolygonDistance,
} from "./world-plan-geometry";

/** How far a parcel's front stands back from its road's edge. */
export const KERB = 0.15;
/** How far inside its coast the town stays: the rim and the lip. */
export const COAST_MARGIN = 4;

export interface RoadDraft {
	/** Arclength of each point. */
	cum: number[];
	readonly folder: string | null;
	readonly id: number;
	/** The road its start lies on, or null for the root's street. */
	readonly parent: number | null;
	points: Point[];
	readonly rank: RoadRank;
	readonly width: number;
}

export interface ParcelDraft {
	/** False for a branch's reserved mouth once its street has grown. */
	alive: boolean;
	readonly axis: Point;
	/** Its outline's box. */
	readonly box: Bounds;
	edge: "none" | "wall" | "hedge" | "fence";
	/** Unit direction from its middle toward its road (its front). */
	readonly face: Point;
	readonly half: readonly [number, number];
	readonly id: number;
	readonly kind: ParcelKind | "reserve";
	/** Its rectangle's frame: middle, along its road, half sizes. */
	readonly middle: Point;
	readonly outline: Point[];
	road: number | null;
}

export interface BuildingDraft {
	readonly at: Point;
	/** Unit direction its front faces. */
	readonly face: Point;
	files: string[];
	half: [number, number];
	kind: BuildingKind;
	readonly parcel: number;
	storeys: number;
}

export interface ZoneDraft {
	readonly kind: ZoneKind;
	readonly outline: Point[];
}

interface SegmentRef {
	readonly road: number;
	readonly seg: number;
}

export interface Town {
	readonly buildings: BuildingDraft[];
	/** The town's middle: the plaza. */
	centre: Point;
	readonly imports: readonly Import[];
	readonly island: string;
	readonly land: Land;
	readonly parcelIndex: SpatialIndex<number>;
	readonly parcels: ParcelDraft[];
	readonly poles: { at: Point; road: number }[];
	/** How far from the centre the town is expected to reach. */
	radius: number;
	readonly roadIndex: SpatialIndex<SegmentRef>;
	readonly roads: RoadDraft[];
	/** The island's seed, from its id. */
	readonly seed: number;
	readonly trees: PlannedTree[];
	readonly zones: ZoneDraft[];
}

export function newTown(
	island: string,
	land: Land,
	imports: readonly Import[],
	seed: number
): Town {
	return {
		island,
		land,
		imports,
		seed,
		centre: [0, 0],
		radius: 1,
		roads: [],
		parcels: [],
		buildings: [],
		zones: [],
		trees: [],
		poles: [],
		roadIndex: new SpatialIndex(),
		parcelIndex: new SpatialIndex(),
	};
}

/** How far a frame point lies from the sea, 0 off the grid. */
export function clearAt(land: Land, p: Point): number {
	const cell = cellAt(land, p[0], p[1]);
	return cell < 0 ? 0 : (land.clear[cell] ?? 0);
}

/** What stands on the cell under a point: `FREE`, `STREET`, a parcel id, or `STREET` off the land. */
export function takenAt(land: Land, p: Point): number {
	const cell = cellAt(land, p[0], p[1]);
	if (cell < 0 || (land.clear[cell] ?? 0) < land.margin) {
		return STREET;
	}
	return land.taken[cell] ?? FREE;
}

// ------------------------------------------------------------------ roads

export function newRoad(
	town: Town,
	start: Point,
	rank: RoadRank,
	folder: string | null,
	parent: number | null
): RoadDraft {
	const road: RoadDraft = {
		id: town.roads.length,
		folder,
		rank,
		width: ROAD_WIDTH[rank],
		points: [start],
		cum: [0],
		parent,
	};
	town.roads.push(road);
	return road;
}

/** Adds a point to a road's end and its new segment to the index. */
export function extendRoad(town: Town, road: RoadDraft, p: Point) {
	const last = road.points.at(-1) as Point;
	road.points.push(p);
	road.cum.push((road.cum.at(-1) ?? 0) + distance(last, p));
	const seg = road.points.length - 2;
	town.roadIndex.insert(boundsOf([last, p], road.width / 2), {
		road: road.id,
		seg,
	});
}

/** Cuts a road back to arclength `s` (its later index entries go stale). */
export function trimRoad(road: RoadDraft, s: number) {
	if (s >= (road.cum.at(-1) ?? 0) - 1e-6) {
		return;
	}
	let k = 1;
	while (k < road.points.length - 1 && (road.cum[k] ?? 0) < s) {
		k += 1;
	}
	const a = road.points[k - 1] as Point;
	const b = road.points[k] as Point;
	const span = (road.cum[k] ?? 0) - (road.cum[k - 1] ?? 0);
	const t = span > 0 ? (s - (road.cum[k - 1] ?? 0)) / span : 0;
	const end: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
	road.points = [...road.points.slice(0, k), end];
	road.cum = arclengths(road.points);
}

/** A road's segment as it is now, or null if it was trimmed away. */
function segmentOf(town: Town, ref: SegmentRef): [Point, Point] | null {
	const road = town.roads[ref.road];
	if (!road || ref.seg + 1 >= road.points.length) {
		return null;
	}
	return [road.points[ref.seg] as Point, road.points[ref.seg + 1] as Point];
}

/** Says which road segments a test leaves out. */
export type Skip = (road: RoadDraft, seg: number) => boolean;
const SKIP_NONE: Skip = () => false;

/**
 * The least gap from `p` to the edge of any road near it (centreline
 * distance less half the road's width), up to `reach`.
 */
export function roadGap(
	town: Town,
	p: Point,
	reach: number,
	skip: Skip = SKIP_NONE
): number {
	let best = reach;
	for (const ref of town.roadIndex.near(boundsOf([p], reach))) {
		const road = town.roads[ref.road] as RoadDraft;
		const segment = segmentOf(town, ref);
		if (!segment || skip(road, ref.seg)) {
			continue;
		}
		const d = segmentDistance(p, segment[0], segment[1]) - road.width / 2;
		best = Math.min(best, d);
	}
	return best;
}

/** The nearest point on any road's centreline to `p` within `reach`, with its road. */
export function nearestRoadPoint(
	town: Town,
	p: Point,
	reach: number,
	skip: Skip = SKIP_NONE
): { at: Point; road: number; seg: number; d: number } | null {
	let best: { at: Point; road: number; seg: number; d: number } | null = null;
	for (const ref of town.roadIndex.near(boundsOf([p], reach))) {
		const road = town.roads[ref.road] as RoadDraft;
		const segment = segmentOf(town, ref);
		if (!segment || skip(road, ref.seg)) {
			continue;
		}
		const { at } = nearestOnSegment(p, segment[0], segment[1]);
		const d = distance(p, at);
		if (d <= reach && (!best || d < best.d)) {
			best = { at, road: ref.road, seg: ref.seg, d };
		}
	}
	return best;
}

// ---------------------------------------------------------------- parcels

/** Whether a segment keeps `gap` clear of every live parcel. */
export function segmentClearOfParcels(
	town: Town,
	a: Point,
	b: Point,
	gap: number,
	except = -1
): boolean {
	const box = boundsOf([a, b]);
	for (const id of town.parcelIndex.near(boundsOf([a, b], gap))) {
		const parcel = town.parcels[id] as ParcelDraft;
		if (
			parcel.alive &&
			id !== except &&
			boxesNear(box, parcel.box, gap) &&
			segmentPolygonDistance(a, b, parcel.outline) < gap
		) {
			return false;
		}
	}
	return true;
}

/** Whether every point along a polygon's edges, about a unit apart, and across its inside clears `margin`. */
function onLand(land: Land, outline: readonly Point[], box: Bounds): boolean {
	const n = outline.length;
	for (let k = 0; k < n; k += 1) {
		const p = outline[k] as Point;
		const q = outline[(k + 1) % n] as Point;
		const steps = Math.max(1, Math.ceil(distance(p, q)));
		for (let m = 0; m < steps; m += 1) {
			const u = p[0] + ((q[0] - p[0]) * m) / steps;
			const v = p[1] + ((q[1] - p[1]) * m) / steps;
			if (clearAt(land, [u, v]) < land.margin) {
				return false;
			}
		}
	}
	const inside = 2;
	if (box.maxU - box.minU <= inside * 2 && box.maxV - box.minV <= inside * 2) {
		return true;
	}
	for (let u = box.minU + inside / 2; u < box.maxU; u += inside) {
		for (let v = box.minV + inside / 2; v < box.maxV; v += inside) {
			if (
				insideConvex(outline, [u, v]) &&
				clearAt(land, [u, v]) < land.margin
			) {
				return false;
			}
		}
	}
	return true;
}

/** How far inside a rectangle's corners the quick test looks: past any cell a neighbour's stamp can reach. */
const CORNER_INSET = 0.6;

/** A quick test before the exact ones: no ground already taken just inside any corner. */
function cornersFree(land: Land, outline: readonly Point[]): boolean {
	let mu = 0;
	let mv = 0;
	for (const p of outline) {
		mu += p[0] / outline.length;
		mv += p[1] / outline.length;
	}
	for (const p of outline) {
		const du = mu - p[0];
		const dv = mv - p[1];
		const length = Math.hypot(du, dv);
		if (length <= CORNER_INSET * 2) {
			continue;
		}
		const u = p[0] + (du / length) * CORNER_INSET * Math.SQRT2;
		const v = p[1] + (dv / length) * CORNER_INSET * Math.SQRT2;
		const cell = cellAt(land, u, v);
		if (cell < 0 || (land.taken[cell] ?? FREE) !== FREE) {
			return false;
		}
	}
	return true;
}

/**
 * Whether a convex outline may be claimed: on land clear of the coast's
 * margin, overlapping no live parcel, and clear of every road's surface
 * by the kerb.
 */
export function parcelFits(town: Town, outline: readonly Point[]): boolean {
	if (!cornersFree(town.land, outline)) {
		return false;
	}
	const box = boundsOf(outline);
	if (!onLand(town.land, outline, box)) {
		return false;
	}
	for (const id of town.parcelIndex.near(box)) {
		const parcel = town.parcels[id] as ParcelDraft;
		if (
			parcel.alive &&
			boxesNear(box, parcel.box, -1e-3) &&
			convexOverlap(outline, parcel.outline)
		) {
			return false;
		}
	}
	const reach = ROAD_WIDTH.main / 2 + KERB;
	for (const ref of town.roadIndex.near(boundsOf(outline, reach))) {
		const segment = segmentOf(town, ref);
		if (!segment) {
			continue;
		}
		const gap = (town.roads[ref.road] as RoadDraft).width / 2 + KERB - 1e-6;
		if (
			boxesNear(box, boundsOf(segment), gap) &&
			segmentPolygonDistance(segment[0], segment[1], outline) < gap
		) {
			return false;
		}
	}
	return true;
}

/** Claims a parcel: it joins the index and the land grid. */
export function addParcel(
	town: Town,
	draft: Omit<ParcelDraft, "id" | "alive" | "box">
): ParcelDraft {
	const box = boundsOf(draft.outline);
	const parcel: ParcelDraft = {
		...draft,
		id: town.parcels.length,
		alive: true,
		box,
	};
	town.parcels.push(parcel);
	town.parcelIndex.insert(box, parcel.id);
	if (parcel.kind !== "reserve") {
		stampPolygon(town.land, parcel.outline, parcel.id);
	}
	return parcel;
}

/** Marks the cells whose middles lie inside an outline as `what`. */
export function stampPolygon(
	land: Land,
	outline: readonly Point[],
	what: number
) {
	forCells(land, outline, (cell) => {
		land.taken[cell] = what;
	});
}

/** Marks the free cells whose middles lie inside an outline as `what`. */
export function stampFree(land: Land, outline: readonly Point[], what: number) {
	forCells(land, outline, (cell) => {
		if (land.taken[cell] === FREE) {
			land.taken[cell] = what;
		}
	});
}

/** Frees the cells inside an outline that hold `what`. */
export function unstamp(land: Land, outline: readonly Point[], what: number) {
	forCells(land, outline, (cell) => {
		if (land.taken[cell] === what) {
			land.taken[cell] = FREE;
		}
	});
}

/** Calls `visit` for each cell whose middle lies inside an outline. */
function forCells(
	land: Land,
	outline: readonly Point[],
	visit: (cell: number) => void
) {
	const box = boundsOf(outline);
	const i0 = Math.max(0, Math.floor((box.minU - land.u0) / CELL));
	const i1 = Math.min(land.cols - 1, Math.floor((box.maxU - land.u0) / CELL));
	const j0 = Math.max(0, Math.floor((box.minV - land.v0) / CELL));
	const j1 = Math.min(land.rows - 1, Math.floor((box.maxV - land.v0) / CELL));
	for (let j = j0; j <= j1; j += 1) {
		for (let i = i0; i <= i1; i += 1) {
			const p: Point = [land.u0 + (i + 0.5) * CELL, land.v0 + (j + 0.5) * CELL];
			if (insideConvex(outline, p)) {
				visit(j * land.cols + i);
			}
		}
	}
}

/** Marks the free cells a road's surface covers as `STREET`. */
export function stampRoad(land: Land, road: RoadDraft) {
	const half = road.width / 2 + CELL / 2;
	for (let k = 0; k + 1 < road.points.length; k += 1) {
		const a = road.points[k] as Point;
		const b = road.points[k + 1] as Point;
		const box = boundsOf([a, b], half);
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
				const cell = j * land.cols + i;
				if (
					land.taken[cell] === FREE &&
					distance(p, nearestOnSegment(p, a, b).at) <= half
				) {
					land.taken[cell] = STREET;
				}
			}
		}
	}
}

// --------------------------------------------------------------- paths

/** A binary heap of cells by cost, for the path search. */
class Heap {
	private readonly cells: number[] = [];
	private readonly costs: number[] = [];

	get size(): number {
		return this.cells.length;
	}

	push(cell: number, cost: number) {
		this.cells.push(cell);
		this.costs.push(cost);
		let k = this.cells.length - 1;
		while (k > 0) {
			const up = Math.floor((k - 1) / 2);
			if ((this.costs[up] ?? 0) <= cost) {
				break;
			}
			this.swap(k, up);
			k = up;
		}
	}

	pop(): number {
		const top = this.cells[0] ?? -1;
		const lastCell = this.cells.pop() ?? -1;
		const lastCost = this.costs.pop() ?? 0;
		if (this.cells.length > 0) {
			this.cells[0] = lastCell;
			this.costs[0] = lastCost;
			this.sink();
		}
		return top;
	}

	private sink() {
		let k = 0;
		const n = this.cells.length;
		for (;;) {
			const l = 2 * k + 1;
			const r = l + 1;
			let least = k;
			if (l < n && (this.costs[l] ?? 0) < (this.costs[least] ?? 0)) {
				least = l;
			}
			if (r < n && (this.costs[r] ?? 0) < (this.costs[least] ?? 0)) {
				least = r;
			}
			if (least === k) {
				return;
			}
			this.swap(k, least);
			k = least;
		}
	}

	private swap(a: number, b: number) {
		const cell = this.cells[a] ?? 0;
		const cost = this.costs[a] ?? 0;
		this.cells[a] = this.cells[b] ?? 0;
		this.costs[a] = this.costs[b] ?? 0;
		this.cells[b] = cell;
		this.costs[b] = cost;
	}
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
	[1, 0, 1],
	[-1, 0, 1],
	[0, 1, 1],
	[0, -1, 1],
	[1, 1, Math.SQRT2],
	[1, -1, Math.SQRT2],
	[-1, 1, Math.SQRT2],
	[-1, -1, Math.SQRT2],
];

/** Cells within `cells` of a parcel's ground, which a path keeps off. */
export function parcelHalo(land: Land, cells: number): Uint8Array {
	const halo = new Uint8Array(land.cols * land.rows);
	for (let j = 0; j < land.rows; j += 1) {
		for (let i = 0; i < land.cols; i += 1) {
			if ((land.taken[j * land.cols + i] ?? FREE) < 0) {
				continue;
			}
			for (let dj = -cells; dj <= cells; dj += 1) {
				for (let di = -cells; di <= cells; di += 1) {
					const x = i + di;
					const y = j + dj;
					if (x >= 0 && y >= 0 && x < land.cols && y < land.rows) {
						halo[y * land.cols + x] = 1;
					}
				}
			}
		}
	}
	return halo;
}

/**
 * The cheapest walk over free land from `from` to a road's ground, as
 * frame points from the road end to `from`, or null. It heads for the
 * nearest road point within `limit` (A*, the straight distance to it as
 * the guide) but stops at the first road cell it reaches. `halo` marks
 * the cells it may not cross.
 */
export function pathToRoad(
	town: Town,
	from: Point,
	halo: Uint8Array,
	limit: number
): Point[] | null {
	const { land } = town;
	const start = cellAt(land, from[0], from[1]);
	const target = nearestRoadPoint(town, from, limit);
	if (start < 0 || !target) {
		return null;
	}
	const search = newSearch(land, start, target.at);
	const maxCost = (limit * 1.6) / CELL;
	while (search.heap.size > 0) {
		const cell = search.heap.pop();
		if (search.done[cell] === 1) {
			continue;
		}
		search.done[cell] = 1;
		if ((search.cost[cell] ?? 0) > maxCost) {
			return null;
		}
		if (land.taken[cell] === STREET && cell !== start) {
			return traceBack(land, search.back, cell);
		}
		expand(town, search, cell, halo);
	}
	return null;
}

interface Search {
	readonly back: Int32Array;
	readonly cost: Float32Array;
	readonly done: Uint8Array;
	readonly heap: Heap;
	/** The goal's cell coordinates, for the guide. */
	readonly ti: number;
	readonly tj: number;
}

function newSearch(land: Land, start: number, goal: Point): Search {
	const size = land.cols * land.rows;
	const search: Search = {
		back: new Int32Array(size).fill(-1),
		cost: new Float32Array(size).fill(Number.POSITIVE_INFINITY),
		done: new Uint8Array(size),
		heap: new Heap(),
		ti: (goal[0] - land.u0) / CELL - 0.5,
		tj: (goal[1] - land.v0) / CELL - 0.5,
	};
	search.cost[start] = 0;
	search.heap.push(start, 0);
	return search;
}

/** Relaxes a cell's neighbours: free land off the halo, or a road's ground to end on. */
function expand(town: Town, search: Search, cell: number, halo: Uint8Array) {
	const { land } = town;
	const rough = roughOf(town);
	const here = search.cost[cell] ?? 0;
	const i = cell % land.cols;
	const j = Math.floor(cell / land.cols);
	for (const [di, dj, step] of NEIGHBOURS) {
		const x = i + di;
		const y = j + dj;
		if (x < 0 || y < 0 || x >= land.cols || y >= land.rows) {
			continue;
		}
		const next = y * land.cols + x;
		const open =
			land.taken[next] === STREET ||
			(halo[next] !== 1 && (land.clear[next] ?? 0) >= land.margin + 0.5);
		if (search.done[next] === 1 || !open) {
			continue;
		}
		// A gentle unevenness, so a footpath wanders rather than runs ruler-straight.
		const total = here + step * roughAt(rough, town.seed, next, x, y);
		if (total < (search.cost[next] ?? 0)) {
			search.cost[next] = total;
			search.back[next] = cell;
			search.heap.push(next, total + Math.hypot(x - search.ti, y - search.tj));
		}
	}
}

/** Each cell's footpath roughness, filled in as paths first cross it. */
const roughCache = new WeakMap<Town, Float32Array>();

function roughOf(town: Town): Float32Array {
	let cache = roughCache.get(town);
	if (!cache) {
		cache = new Float32Array(town.land.cols * town.land.rows);
		roughCache.set(town, cache);
	}
	return cache;
}

function roughAt(
	cache: Float32Array,
	seed: number,
	cell: number,
	i: number,
	j: number
): number {
	const known = cache[cell] ?? 0;
	if (known > 0) {
		return known;
	}
	const value = 1 + 0.8 * noise2(seed, i / 9, j / 9);
	cache[cell] = value;
	return value;
}

function traceBack(land: Land, back: Int32Array, end: number): Point[] {
	const out: Point[] = [];
	let cell = end;
	while (cell >= 0) {
		const i = cell % land.cols;
		const j = Math.floor(cell / land.cols);
		out.push([land.u0 + (i + 0.5) * CELL, land.v0 + (j + 0.5) * CELL]);
		cell = back[cell] ?? -1;
	}
	return out;
}

/** A grid walk smoothed (two rounds of corner cutting) and resampled about a unit apart. */
export function smoothPath(points: readonly Point[]): Point[] {
	let line = [...points];
	for (let round = 0; round < 3; round += 1) {
		if (line.length < 3) {
			break;
		}
		const next: Point[] = [line[0] as Point];
		for (let k = 0; k + 1 < line.length; k += 1) {
			const a = line[k] as Point;
			const b = line[k + 1] as Point;
			next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
			next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
		}
		next.push(line.at(-1) as Point);
		line = next;
	}
	return resample(line, 1);
}

/** A polyline resampled at even steps of about `step`, its ends kept. */
export function resample(points: readonly Point[], step: number): Point[] {
	const cum = arclengths(points);
	const total = cum.at(-1) ?? 0;
	const n = Math.max(1, Math.ceil(total / step));
	const out: Point[] = [];
	let k = 0;
	for (let m = 0; m <= n; m += 1) {
		const s = (total * m) / n;
		while (k + 2 < points.length && (cum[k + 1] ?? 0) < s) {
			k += 1;
		}
		const a = points[k] as Point;
		const b = points[Math.min(k + 1, points.length - 1)] as Point;
		const span = (cum[k + 1] ?? 0) - (cum[k] ?? 0);
		const t =
			span > 0 ? Math.min(1, Math.max(0, (s - (cum[k] ?? 0)) / span)) : 0;
		out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
	}
	return out;
}
