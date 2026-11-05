/**
 * The land a town is planned on (world-plan.ts): an island's coast laid on a fine grid in the island's own
 * frame, its long axis along the frame's u and its short axis along v.
 * Each cell knows how far it lies from the sea and what stands on it, so
 * the planner can ask whether a lot or a stretch of street fits without
 * searching the coast again. Holes in the coast (craters) are sea too.
 *
 * world-plan.ts lays its streets and lots at any angle and uses the grid
 * only for its fields (clearance, what is taken), testing its shapes
 * exactly itself. The box helpers cover the cells whose middles lie
 * inside an upright rectangle.
 */
import type { Point, Polygon, Ring } from "../../../data/chart";

/** Chart units a side of a cell. */
export const CELL = 0.5;
/** What a cell holds: nothing yet, a street, or else the lot of that id. */
export const FREE = -1;
export const STREET = -2;
/** Cells kept round the coast's box, so the grid's edge is always sea. */
const PAD_CELLS = 2;
/** A chamfer step's cost across a cell's corner, in cells. */
const DIAGONAL = Math.SQRT2;

export interface Land {
	/** The frame's origin: the coast's centre of area. */
	readonly centre: Point;
	/** Each cell's distance to the sea, chart units. */
	readonly clear: Float32Array;
	readonly cols: number;
	/** The frame's u axis in the chart: (cos, sin); v is u turned a quarter left. */
	readonly cos: number;
	/** How far inside the coast a building or street must stay. */
	readonly margin: number;
	readonly rows: number;
	readonly sin: number;
	/** What stands on each cell: `FREE`, `STREET` or a lot's id. */
	readonly taken: Int32Array;
	/** The frame position of cell (0, 0)'s lower corner. */
	readonly u0: number;
	readonly v0: number;
}

/** A rectangle in the frame, upright: from (u0, v0) to (u1, v1). */
export interface Box {
	readonly u0: number;
	readonly u1: number;
	readonly v0: number;
	readonly v1: number;
}

/** A frame position to the chart. */
export const toChart = (land: Land, u: number, v: number): Point => [
	land.centre[0] + u * land.cos - v * land.sin,
	land.centre[1] + u * land.sin + v * land.cos,
];

/** A frame direction to the chart. */
export const directionToChart = (land: Land, du: number, dv: number): Point => [
	du * land.cos - dv * land.sin,
	du * land.sin + dv * land.cos,
];

/** The ring's centre of area and second moments about it. */
function momentsOf(ring: Ring) {
	let area = 0;
	let x = 0;
	let y = 0;
	let xx = 0;
	let yy = 0;
	let xy = 0;
	for (const [index, [x0, y0]] of ring.entries()) {
		const [x1, y1] = ring[(index + 1) % ring.length] ?? [x0, y0];
		const cross = x0 * y1 - x1 * y0;
		area += cross / 2;
		x += ((x0 + x1) * cross) / 6;
		y += ((y0 + y1) * cross) / 6;
		xx += ((x0 * x0 + x0 * x1 + x1 * x1) * cross) / 12;
		yy += ((y0 * y0 + y0 * y1 + y1 * y1) * cross) / 12;
		xy += ((x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cross) / 24;
	}
	if (Math.abs(area) < 1e-9) {
		const [first] = ring;
		return { area: 0, centre: first ?? ([0, 0] as Point), angle: 0 };
	}
	const cx = x / area;
	const cy = y / area;
	const sxx = xx / area - cx * cx;
	const syy = yy / area - cy * cy;
	const sxy = xy / area - cx * cy;
	const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
	return { area: Math.abs(area), centre: [cx, cy] as Point, angle };
}

/**
 * For each row of cells, the frame positions where the row's middle line
 * crosses the polygon's rings, in order. Each edge adds itself only to the
 * rows it spans.
 */
function crossingsOf(
	rings: readonly (readonly (readonly [number, number])[])[],
	v0: number,
	rows: number
): number[][] {
	const crossings: number[][] = Array.from({ length: rows }, () => []);
	for (const ring of rings) {
		for (const [index, [ua, va]] of ring.entries()) {
			const [ub, vb] = ring[(index + 1) % ring.length] ?? [ua, va];
			const first = Math.max(
				Math.ceil((Math.min(va, vb) - v0) / CELL - 0.5),
				0
			);
			const last = Math.min(
				Math.floor((Math.max(va, vb) - v0) / CELL - 0.5),
				rows - 1
			);
			for (let j = first; j <= last; j += 1) {
				const v = v0 + (j + 0.5) * CELL;
				if (va > v !== vb > v) {
					crossings[j]?.push(ua + ((v - va) * (ub - ua)) / (vb - va));
				}
			}
		}
	}
	for (const row of crossings) {
		row.sort((a, b) => a - b);
	}
	return crossings;
}

/** Two chamfer passes: each inside cell's distance to the nearest sea cell. */
function chamfer(clear: Float32Array, cols: number, rows: number) {
	const look = (i: number, j: number): number =>
		i < 0 || j < 0 || i >= cols || j >= rows
			? 0
			: (clear[j * cols + i] ?? Number.POSITIVE_INFINITY);
	const pass = (forward: boolean) => {
		const step = forward ? 1 : -1;
		for (let n = 0; n < rows; n += 1) {
			const j = forward ? n : rows - 1 - n;
			for (let m = 0; m < cols; m += 1) {
				const i = forward ? m : cols - 1 - m;
				const index = j * cols + i;
				const here = clear[index] ?? 0;
				if (here === 0) {
					continue;
				}
				clear[index] = Math.min(
					here,
					look(i - step, j) + 1,
					look(i, j - step) + 1,
					look(i - step, j - step) + DIAGONAL,
					look(i + step, j - step) + DIAGONAL
				);
			}
		}
	};
	pass(true);
	pass(false);
}

/** An island's land from its coast polygon, `margin` kept clear of its lip. */
export function landOf(polygon: Polygon, margin: number): Land {
	const { centre, angle } = momentsOf(polygon.outer);
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const rings = [polygon.outer, ...polygon.holes].map((ring) =>
		ring.map(
			([x, y]) =>
				[
					(x - centre[0]) * cos + (y - centre[1]) * sin,
					-(x - centre[0]) * sin + (y - centre[1]) * cos,
				] as const
		)
	);
	const us = rings.flat().map(([u]) => u);
	const vs = rings.flat().map(([, v]) => v);
	const u0 = Math.min(...us) - PAD_CELLS * CELL;
	const v0 = Math.min(...vs) - PAD_CELLS * CELL;
	const cols = Math.ceil((Math.max(...us) - u0) / CELL) + PAD_CELLS;
	const rows = Math.ceil((Math.max(...vs) - v0) / CELL) + PAD_CELLS;
	const clear = new Float32Array(cols * rows);
	for (const [j, crossings] of crossingsOf(rings, v0, rows).entries()) {
		for (let k = 0; k + 1 < crossings.length; k += 2) {
			const from = Math.ceil(((crossings[k] ?? 0) - u0) / CELL - 0.5);
			const to = Math.floor(((crossings[k + 1] ?? 0) - u0) / CELL - 0.5);
			for (let i = Math.max(from, 0); i <= Math.min(to, cols - 1); i += 1) {
				clear[j * cols + i] = Number.POSITIVE_INFINITY;
			}
		}
	}
	chamfer(clear, cols, rows);
	for (let index = 0; index < clear.length; index += 1) {
		clear[index] = (clear[index] ?? 0) * CELL;
	}
	const taken = new Int32Array(cols * rows).fill(FREE);
	return { centre, cos, sin, u0, v0, cols, rows, clear, taken, margin };
}

/** The cell under a frame position, or -1 off the grid. */
export function cellAt(land: Land, u: number, v: number): number {
	const i = Math.floor((u - land.u0) / CELL);
	const j = Math.floor((v - land.v0) / CELL);
	if (i < 0 || j < 0 || i >= land.cols || j >= land.rows) {
		return -1;
	}
	return j * land.cols + i;
}

/** Whether a cell is land clear of the coast's margin. */
export const isBuildable = (land: Land, cell: number): boolean =>
	cell >= 0 && (land.clear[cell] ?? 0) >= land.margin;

/** Whether a cell is buildable and nothing stands on it yet. */
export const isFree = (land: Land, cell: number): boolean =>
	isBuildable(land, cell) && land.taken[cell] === FREE;

/** Whether a street may run over a cell: buildable, no lot on it. */
export const isStreetable = (land: Land, cell: number): boolean =>
	isBuildable(land, cell) && (land.taken[cell] ?? FREE) < 0;

/** A hair inside a box's edges, so boxes that only touch share no cell. */
const EDGE = 1e-6;

/** The first and last cells along one axis a span from `a` to `b` covers. */
function spanOf(a: number, b: number, touching: boolean): [number, number] {
	if (touching) {
		return [Math.floor((a + EDGE) / CELL), Math.floor((b - EDGE) / CELL)];
	}
	return [Math.ceil(a / CELL - 0.5), Math.floor(b / CELL - 0.5)];
}

/**
 * The cells a box covers, or null when part of it is off the grid: those
 * whose middles it holds, or with `touching` every cell it reaches into,
 * so two lots that each take all they touch can never overlap.
 */
function cellsOf(land: Land, box: Box, touching = false): number[] | null {
	const cells: number[] = [];
	const inside = everyCell(land, box, touching, (cell) => {
		cells.push(cell);
		return true;
	});
	return inside ? cells : null;
}

/** Whether `test` holds for every cell a box covers (as `cellsOf`), all on the grid. */
function everyCell(
	land: Land,
	box: Box,
	touching: boolean,
	test: (cell: number) => boolean
): boolean {
	const [i0, i1] = spanOf(box.u0 - land.u0, box.u1 - land.u0, touching);
	const [j0, j1] = spanOf(box.v0 - land.v0, box.v1 - land.v0, touching);
	if (i0 < 0 || j0 < 0 || i1 >= land.cols || j1 >= land.rows) {
		return false;
	}
	for (let j = j0; j <= j1; j += 1) {
		for (let i = i0; i <= i1; i += 1) {
			if (!test(j * land.cols + i)) {
				return false;
			}
		}
	}
	return true;
}

/** Whether a box lies on buildable land that nothing stands on yet. */
export const boxFits = (land: Land, box: Box): boolean =>
	everyCell(land, box, true, (cell) => isFree(land, cell));

/** Whether a street may run over every cell of a box. */
export const boxStreetable = (land: Land, box: Box): boolean =>
	everyCell(land, box, false, (cell) => isStreetable(land, cell));

/** Marks a box's cells as `what`: a lot all it touches, a street the free cells it holds. */
export function take(land: Land, box: Box, what: number) {
	for (const cell of cellsOf(land, box, what !== STREET) ?? []) {
		if (what !== STREET || land.taken[cell] === FREE) {
			land.taken[cell] = what;
		}
	}
}

/** The free spot nearest (u, v) where a box of these half sizes fits, or null. */
export function nearestSpot(
	land: Land,
	u: number,
	v: number,
	halfU: number,
	halfV: number
): Point | null {
	const reach = Math.max(land.cols, land.rows) * CELL;
	for (let ring = 0; ring <= reach; ring += 1) {
		const steps = Math.max(1, ring * 8);
		for (let k = 0; k < steps; k += 1) {
			const a = (k / steps) * 2 * Math.PI;
			const pu = u + Math.cos(a) * ring;
			const pv = v + Math.sin(a) * ring;
			const box = {
				u0: pu - halfU,
				u1: pu + halfU,
				v0: pv - halfV,
				v1: pv + halfV,
			};
			if (boxFits(land, box)) {
				return [pu, pv];
			}
		}
	}
	return null;
}

/** The buildable cell farthest from the sea: the plateau's heart. */
export function heartOf(land: Land): Point {
	let best = 0;
	let bestCell = -1;
	for (let cell = 0; cell < land.clear.length; cell += 1) {
		const clear = land.clear[cell] ?? 0;
		if (clear > best) {
			best = clear;
			bestCell = cell;
		}
	}
	const i = Math.max(bestCell, 0) % land.cols;
	const j = Math.floor(Math.max(bestCell, 0) / land.cols);
	return [land.u0 + (i + 0.5) * CELL, land.v0 + (j + 0.5) * CELL];
}
