/**
 * Geometry for the world planner (world-plan.ts): seeded hashes and noise,
 * polylines measured by arclength, convex polygon tests and a spatial
 * index of roads and parcels. Everything works in one flat frame (the
 * island's own, town-land.ts); nothing here knows about the chart.
 */
import type { Point } from "../../../data/chart";

const TWO_32 = 2 ** 32;
const TWO_16 = 2 ** 16;
/** Two odd constants for the integer mix (from the murmur finaliser). */
const MIX_A = 0x85_eb_ca_6b;
const MIX_B = 0xc2_b2_ae_35;
const GOLDEN = 0x9e_37_79_b9;

/** A 32-bit mix of an integer, without bitwise operators: 0 to 2^32. */
function mix(value: number): number {
	let h = Math.imul(value + GOLDEN, MIX_A);
	h = Math.imul(h + Math.floor((h + TWO_32) / TWO_16), MIX_B);
	h = Math.imul(h + Math.floor((h + TWO_32) / TWO_16), MIX_A);
	return ((h % TWO_32) + TWO_32) % TWO_32;
}

/** A stable number for a text (a path), 0 to 2^32. */
export function hashText(text: string): number {
	let h = 7;
	for (let index = 0; index < text.length; index += 1) {
		h = mix(h + text.charCodeAt(index) * 131 + index);
	}
	return h;
}

/** A number in [0, 1) from a seed and a few integers. */
export function unit(seed: number, ...keys: number[]): number {
	let h = seed;
	for (const key of keys) {
		h = mix(h + Math.imul(Math.floor(key), 0x27_d4_eb_2d));
	}
	return mix(h) / TWO_32;
}

/** A number in [0, 1) from a text and a few integers. */
export const unitOf = (text: string, ...keys: number[]): number =>
	unit(hashText(text), ...keys);

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Smooth one-dimensional value noise in [-1, 1], features about one unit of `x` apart. */
export function noise1(seed: number, x: number): number {
	const i = Math.floor(x);
	const t = smooth(x - i);
	const a = unit(seed, i);
	const b = unit(seed, i + 1);
	return (a + (b - a) * t) * 2 - 1;
}

/** Smooth two-dimensional value noise in [0, 1], features about one unit apart. */
export function noise2(seed: number, x: number, y: number): number {
	const i = Math.floor(x);
	const j = Math.floor(y);
	const tx = smooth(x - i);
	const ty = smooth(y - j);
	const a = unit(seed, i, j);
	const b = unit(seed, i + 1, j);
	const c = unit(seed, i, j + 1);
	const d = unit(seed, i + 1, j + 1);
	const top = a + (b - a) * tx;
	const bottom = c + (d - c) * tx;
	return top + (bottom - top) * ty;
}

// ---------------------------------------------------------------- vectors

export const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: Point, k: number): Point => [a[0] * k, a[1] * k];
export const dot = (a: Point, b: Point): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];
export const lengthOf = (a: Point): number =>
	Math.sqrt(a[0] * a[0] + a[1] * a[1]);
export const distance = (a: Point, b: Point): number => {
	const du = a[0] - b[0];
	const dv = a[1] - b[1];
	return Math.sqrt(du * du + dv * dv);
};
/** The direction at `angle`, radians from +u toward +v. */
export const heading = (angle: number): Point => [
	Math.cos(angle),
	Math.sin(angle),
];
/** A direction turned a quarter toward +v (the left of a road running along it). */
export const leftOf = (a: Point): Point => [-a[1], a[0]];

export function normalise(a: Point): Point {
	const length = Math.sqrt(a[0] * a[0] + a[1] * a[1]);
	return length > 0 ? [a[0] / length, a[1] / length] : [1, 0];
}

/** The angle between two angles, in [-pi, pi]. */
export function angleBetween(a: number, b: number): number {
	let d = (b - a) % (2 * Math.PI);
	if (d > Math.PI) {
		d -= 2 * Math.PI;
	} else if (d < -Math.PI) {
		d += 2 * Math.PI;
	}
	return d;
}

// -------------------------------------------------------------- polylines

/** Each point's distance along a polyline from its first. */
export function arclengths(points: readonly Point[]): number[] {
	const out = [0];
	for (let k = 1; k < points.length; k += 1) {
		const a = points[k - 1] as Point;
		const b = points[k] as Point;
		out.push((out[k - 1] ?? 0) + distance(a, b));
	}
	return out;
}

/** The point and unit tangent at arclength `s`, clamped to the line. */
export function pointAt(
	points: readonly Point[],
	cumulative: readonly number[],
	s: number
): { at: Point; tangent: Point } {
	const last = points.length - 1;
	const total = cumulative[last] ?? 0;
	const clamped = Math.max(0, Math.min(total, s));
	let lo = 0;
	let hi = last;
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if ((cumulative[mid] ?? 0) <= clamped) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	const a = points[lo] as Point;
	const b = points[Math.min(lo + 1, last)] as Point;
	const span =
		(cumulative[Math.min(lo + 1, last)] ?? 0) - (cumulative[lo] ?? 0);
	const t = span > 0 ? (clamped - (cumulative[lo] ?? 0)) / span : 0;
	return {
		at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
		tangent: normalise(sub(b, a)),
	};
}

/** The nearest point on a segment to `p`, and how far along (0 to 1). */
export function nearestOnSegment(
	p: Point,
	a: Point,
	b: Point
): { at: Point; t: number } {
	const ab = sub(b, a);
	const length = dot(ab, ab);
	const t =
		length > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / length)) : 0;
	return { at: [a[0] + ab[0] * t, a[1] + ab[1] * t], t };
}

export function segmentDistance(p: Point, a: Point, b: Point): number {
	const abu = b[0] - a[0];
	const abv = b[1] - a[1];
	const length = abu * abu + abv * abv;
	const t =
		length > 0
			? Math.max(
					0,
					Math.min(1, ((p[0] - a[0]) * abu + (p[1] - a[1]) * abv) / length)
				)
			: 0;
	const du = a[0] + abu * t - p[0];
	const dv = a[1] + abv * t - p[1];
	return Math.sqrt(du * du + dv * dv);
}

/** Whether segments ab and cd cross, touching ends excluded by `eps`. */
function segmentsCross(
	a: Point,
	b: Point,
	c: Point,
	d: Point,
	eps: number
): boolean {
	const abu = b[0] - a[0];
	const abv = b[1] - a[1];
	const cdu = d[0] - c[0];
	const cdv = d[1] - c[1];
	const d1 = abu * (c[1] - a[1]) - abv * (c[0] - a[0]);
	const d2 = abu * (d[1] - a[1]) - abv * (d[0] - a[0]);
	const d3 = cdu * (a[1] - c[1]) - cdv * (a[0] - c[0]);
	const d4 = cdu * (b[1] - c[1]) - cdv * (b[0] - c[0]);
	return (
		((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
		((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
	);
}

/** How near its chord a stretch of road stays and still counts as straight. */
export const STRAIGHT_SLACK = 0.5;

/**
 * Whether the stretch from `points[from]` through `points[to]`, then on to
 * `extra` if given, stays within the slack of its chord.
 */
export function isStraight(
	points: readonly Point[],
	from: number,
	to: number,
	extra?: Point,
	slack = STRAIGHT_SLACK
): boolean {
	const a = points[from] as Point;
	const b = extra ?? (points[to] as Point);
	const last = extra ? to : to - 1;
	for (let k = from + 1; k <= last; k += 1) {
		if (segmentDistance(points[k] as Point, a, b) > slack) {
			return false;
		}
	}
	return true;
}

/** The longest straight stretch (by `isStraight`) between any two of a polyline's points from `from` on. */
export function longestStraight(points: readonly Point[], from = 0): number {
	let longest = 0;
	for (let i = from; i < points.length; i += 1) {
		for (let j = points.length - 1; j > i; j -= 1) {
			const chord = distance(points[i] as Point, points[j] as Point);
			if (chord <= longest) {
				break;
			}
			if (isStraight(points, i, j)) {
				longest = chord;
				break;
			}
		}
	}
	return longest;
}

// --------------------------------------------------------------- polygons

/** Twice the signed area: positive when counter-clockwise (u right, v up). */
export function signedArea(ring: readonly Point[]): number {
	let area = 0;
	for (const [k, p] of ring.entries()) {
		const q = ring[(k + 1) % ring.length] ?? p;
		area += p[0] * q[1] - q[0] * p[1];
	}
	return area / 2;
}

/** A rectangle's corners, counter-clockwise, from its middle, its x axis and half sizes. */
export function rectangle(
	middle: Point,
	axis: Point,
	halfX: number,
	halfZ: number
): Point[] {
	const z = leftOf(axis);
	const corner = (sx: number, sz: number): Point => [
		middle[0] + axis[0] * halfX * sx + z[0] * halfZ * sz,
		middle[1] + axis[1] * halfX * sx + z[1] * halfZ * sz,
	];
	return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

/** Whether a point lies inside a polygon (even-odd). */
export function contains(ring: readonly Point[], [x, y]: Point): boolean {
	let inside = false;
	for (const [k, [x0, y0]] of ring.entries()) {
		const [x1, y1] = ring[(k + 1) % ring.length] ?? [x0, y0];
		if (y0 > y !== y1 > y && x < x0 + ((y - y0) * (x1 - x0)) / (y1 - y0)) {
			inside = !inside;
		}
	}
	return inside;
}

/** Whether a point lies inside a counter-clockwise convex polygon (edges included). */
export function insideConvex(ring: readonly Point[], p: Point): boolean {
	const n = ring.length;
	for (let k = 0; k < n; k += 1) {
		const a = ring[k] as Point;
		const b = ring[(k + 1) % n] as Point;
		if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) {
			return false;
		}
	}
	return true;
}

/** Whether two boxes come within `gap` of each other. */
export const boxesNear = (a: Bounds, b: Bounds, gap: number): boolean =>
	a.minU <= b.maxU + gap &&
	b.minU <= a.maxU + gap &&
	a.minV <= b.maxV + gap &&
	b.minV <= a.maxV + gap;

/** Whether two convex polygons overlap by more than `eps` (touching edges don't). */
export function convexOverlap(
	a: readonly Point[],
	b: readonly Point[],
	eps = 1e-3
): boolean {
	return !(separates(a, a, b, eps) || separates(a, b, b, eps));
}

/** Whether one of `ring`'s edge normals separates `a` from `b` by more than `eps`. */
function separates(
	ring: readonly Point[],
	a: readonly Point[],
	b: readonly Point[],
	eps: number
): boolean {
	const n = ring.length;
	for (let k = 0; k < n; k += 1) {
		const p = ring[k] as Point;
		const q = ring[(k + 1) % n] as Point;
		const ax = q[1] - p[1];
		const ay = p[0] - q[0];
		const length = Math.sqrt(ax * ax + ay * ay);
		if (length === 0) {
			continue;
		}
		let minA = Number.POSITIVE_INFINITY;
		let maxA = Number.NEGATIVE_INFINITY;
		let minB = Number.POSITIVE_INFINITY;
		let maxB = Number.NEGATIVE_INFINITY;
		for (const v of a) {
			const x = (v[0] * ax + v[1] * ay) / length;
			minA = Math.min(minA, x);
			maxA = Math.max(maxA, x);
		}
		for (const v of b) {
			const x = (v[0] * ax + v[1] * ay) / length;
			minB = Math.min(minB, x);
			maxB = Math.max(maxB, x);
		}
		if (maxA <= minB + eps || maxB <= minA + eps) {
			return true;
		}
	}
	return false;
}

/** The least distance from a segment to a convex counter-clockwise polygon: 0 when they touch or cross. */
export function segmentPolygonDistance(
	a: Point,
	b: Point,
	ring: readonly Point[]
): number {
	if (insideConvex(ring, a) || insideConvex(ring, b)) {
		return 0;
	}
	let best = Number.POSITIVE_INFINITY;
	for (const [k, p] of ring.entries()) {
		const q = ring[(k + 1) % ring.length] ?? p;
		if (segmentsCross(a, b, p, q, 0)) {
			return 0;
		}
		best = Math.min(
			best,
			segmentDistance(p, a, b),
			segmentDistance(a, p, q),
			segmentDistance(b, p, q)
		);
	}
	return best;
}

/** The smallest convex ring round a set of points, counter-clockwise. */
export function convexHull(points: readonly Point[]): Point[] {
	const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
	if (sorted.length < 3) {
		return sorted;
	}
	const half = (list: readonly Point[]): Point[] => {
		const out: Point[] = [];
		for (const p of list) {
			while (out.length >= 2) {
				const o = out.at(-2) as Point;
				const m = out.at(-1) as Point;
				if (cross(sub(m, o), sub(p, o)) > 0) {
					break;
				}
				out.pop();
			}
			out.push(p);
		}
		out.pop();
		return out;
	};
	return [...half(sorted), ...half([...sorted].reverse())];
}

export function centroidOf(ring: readonly Point[]): Point {
	let x = 0;
	let y = 0;
	for (const p of ring) {
		x += p[0];
		y += p[1];
	}
	return [x / Math.max(ring.length, 1), y / Math.max(ring.length, 1)];
}

export interface Bounds {
	readonly maxU: number;
	readonly maxV: number;
	readonly minU: number;
	readonly minV: number;
}

export function boundsOf(points: readonly Point[], pad = 0): Bounds {
	let minU = Number.POSITIVE_INFINITY;
	let minV = Number.POSITIVE_INFINITY;
	let maxU = Number.NEGATIVE_INFINITY;
	let maxV = Number.NEGATIVE_INFINITY;
	for (const [u, v] of points) {
		minU = Math.min(minU, u);
		minV = Math.min(minV, v);
		maxU = Math.max(maxU, u);
		maxV = Math.max(maxV, v);
	}
	return {
		minU: minU - pad,
		minV: minV - pad,
		maxU: maxU + pad,
		maxV: maxV + pad,
	};
}

// ---------------------------------------------------------- the index

/** Chart units a side of an index bucket. */
const BUCKET = 4;

/**
 * Roads' segments and parcels' outlines by bucket, so a test near a point
 * reads only what stands near it.
 */
export class SpatialIndex<T> {
	private readonly buckets = new Map<number, T[]>();

	private keyOf(i: number, j: number): number {
		return (j + 4096) * 8192 + (i + 4096);
	}

	insert(bounds: Bounds, item: T) {
		const i0 = Math.floor(bounds.minU / BUCKET);
		const i1 = Math.floor(bounds.maxU / BUCKET);
		const j0 = Math.floor(bounds.minV / BUCKET);
		const j1 = Math.floor(bounds.maxV / BUCKET);
		for (let j = j0; j <= j1; j += 1) {
			for (let i = i0; i <= i1; i += 1) {
				const key = this.keyOf(i, j);
				const list = this.buckets.get(key);
				if (list) {
					list.push(item);
				} else {
					this.buckets.set(key, [item]);
				}
			}
		}
	}

	/**
	 * Every item whose bounds share a bucket with these. An item spanning
	 * several buckets may come more than once; every caller asks only
	 * whether any item passes a test, or which is nearest, so that is fine.
	 */
	near(bounds: Bounds): T[] {
		const i0 = Math.floor(bounds.minU / BUCKET);
		const i1 = Math.floor(bounds.maxU / BUCKET);
		const j0 = Math.floor(bounds.minV / BUCKET);
		const j1 = Math.floor(bounds.maxV / BUCKET);
		if (i0 === i1 && j0 === j1) {
			return this.buckets.get(this.keyOf(i0, j0)) ?? [];
		}
		const out: T[] = [];
		for (let j = j0; j <= j1; j += 1) {
			for (let i = i0; i <= i1; i += 1) {
				const list = this.buckets.get(this.keyOf(i, j));
				if (list) {
					for (const item of list) {
						out.push(item);
					}
				}
			}
		}
		return out;
	}
}
