/**
 * Utility poles and their wires (REFERENCES.md rule 12): a concrete pole at
 * each of the plan's poles, its cross arm square to its road, a
 * transformer on some, and wires sagging from each pole to the next along
 * the same road. A pole stands on a site of its own; a wire hangs between
 * its two poles' sites, so its ends follow the ground found for them
 * (shaders/world/town-floors.wgsl) and the wire draw samples nothing else.
 */
import type { Point } from "../../../data/chart";
import { COLORS } from "./structures-palette";
import { type TownPart, townPart, turned, variantOf } from "./town-parts";
import type { Road, WorldPlan } from "./world";

/** Chart units: about ten metres of pole, its cross arm near the top. */
const POLE_HEIGHT = 2.4;
const POLE_RADIUS = 0.034;
const ARM_HEIGHT = 2.18;
const ARM_HALF = 0.26;
/** Where the wires hang from: the arm's ends and middle, and the telephone cable lower down. */
const HIGH_WIRES: readonly [number, number][] = [
	[-ARM_HALF + 0.03, ARM_HEIGHT + 0.04],
	[ARM_HALF - 0.03, ARM_HEIGHT + 0.04],
	[0.08, POLE_HEIGHT - 0.04],
];
const LOW_WIRE: readonly [number, number] = [-0.06, 1.55];
/** The longest span strung, and a wire's sag for each unit of span squared. */
const MAX_SPAN = 16;
const SAG_PER_SPAN2 = 0.0016;
/** Wire radii, chart units: the power lines, and the thicker telephone cable. */
const WIRE_RADIUS = 0.006;
const CABLE_RADIUS = 0.011;
/** One pole in this many carries a transformer. */
const TRANSFORMER_SHARE = 0.3;

/** A wire between two poles' sites, its ends on the chart and above each site's ground. */
export interface Wire {
	readonly a: Point;
	readonly b: Point;
	readonly heightA: number;
	readonly heightB: number;
	readonly radius: number;
	readonly sag: number;
	readonly siteA: number;
	readonly siteB: number;
}

/** A pole placed on the chart: its parts in its own frame, turned so its local z runs along its road. */
export interface PolePlace {
	readonly at: Point;
	readonly parts: readonly TownPart[];
	readonly turn: number;
}

/** How far along a road's centreline a point lies, and the road's heading there. */
function along(points: readonly Point[], p: Point): { s: number; dir: Point } {
	let best = Number.POSITIVE_INFINITY;
	let bestS = 0;
	let dir: Point = [1, 0];
	let run = 0;
	for (let k = 0; k + 1 < points.length; k += 1) {
		const a = points[k] as Point;
		const b = points[k + 1] as Point;
		const dx = b[0] - a[0];
		const dz = b[1] - a[1];
		const length = Math.hypot(dx, dz);
		if (length === 0) {
			continue;
		}
		const t = Math.min(
			Math.max(
				((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (length * length),
				0
			),
			1
		);
		const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
		if (d < best) {
			best = d;
			bestS = run + t * length;
			dir = [dx / length, dz / length];
		}
		run += length;
	}
	return { s: bestS, dir };
}

const poleParts = (at: Point): TownPart[] => {
	const parts: TownPart[] = [
		townPart({
			shape: "round",
			half: [POLE_RADIUS, POLE_RADIUS],
			wall: POLE_HEIGHT,
			rise: 0.03,
			overhang: 0,
			material: "concrete",
			color: COLORS.pole,
			trim: "concrete",
			trimColor: COLORS.pole,
			ownSite: true,
		}),
		townPart({
			shape: "box",
			half: [ARM_HALF, 0.018],
			base: ARM_HEIGHT,
			wall: 0.035,
			material: "steel",
			ownSite: true,
		}),
	];
	if (variantOf([at[0] * 1.7, at[1] * 0.9]) < TRANSFORMER_SHARE) {
		parts.push(
			townPart({
				shape: "round",
				at: [0.1, 0],
				half: [0.07, 0.07],
				base: 1.78,
				wall: 0.22,
				rise: 0.03,
				overhang: 0.01,
				material: "grey",
				color: "#8e9496",
				trim: "grey",
				trimColor: "#7e8486",
				ownSite: true,
			})
		);
	}
	return parts;
};

/**
 * Every pole, and the wires between neighbours on one road. `siteOf(k)`
 * is the site the k-th pole was given, so the wires can name it.
 */
export function polesOf(plan: WorldPlan): {
	poles: PolePlace[];
	wiresOf: (siteOf: (pole: number) => number) => Wire[];
} {
	const byRoad = new Map<number, { k: number; s: number }[]>();
	const poles: PolePlace[] = plan.poles.map((pole, k) => {
		const road: Road | undefined = plan.roads[pole.road];
		const { s, dir } = road
			? along(road.points, pole.at)
			: { s: k, dir: [1, 0] as Point };
		const list = byRoad.get(pole.road) ?? [];
		list.push({ k, s });
		byRoad.set(pole.road, list);
		// Local z along the road: (−sin, cos) is the heading.
		return {
			at: pole.at,
			turn: Math.atan2(-dir[0], dir[1]),
			parts: poleParts(pole.at),
		};
	});
	const wiresOf = (siteOf: (pole: number) => number): Wire[] => {
		const wires: Wire[] = [];
		for (const list of byRoad.values()) {
			list.sort((x, y) => x.s - y.s);
			for (let i = 0; i + 1 < list.length; i += 1) {
				const ka = (list[i] as { k: number }).k;
				const kb = (list[i + 1] as { k: number }).k;
				const pa = poles[ka] as PolePlace;
				const pb = poles[kb] as PolePlace;
				const span = Math.hypot(pb.at[0] - pa.at[0], pb.at[1] - pa.at[1]);
				if (span > MAX_SPAN || span < 0.5) {
					continue;
				}
				const sag = SAG_PER_SPAN2 * span * span;
				const strung = [
					...HIGH_WIRES.map(([x, h]) => ({ x, h, radius: WIRE_RADIUS })),
					{ x: LOW_WIRE[0], h: LOW_WIRE[1], radius: CABLE_RADIUS },
				];
				for (const { x, h, radius } of strung) {
					const oa = turned([x, 0], pa.turn);
					const ob = turned([x, 0], pb.turn);
					wires.push({
						a: [pa.at[0] + oa[0], pa.at[1] + oa[1]],
						b: [pb.at[0] + ob[0], pb.at[1] + ob[1]],
						heightA: h,
						heightB: h,
						radius,
						sag: radius === CABLE_RADIUS ? sag * 1.3 : sag,
						siteA: siteOf(ka),
						siteB: siteOf(kb),
					});
				}
			}
		}
		return wires;
	};
	return { poles, wiresOf };
}

/** vec4f a wire (shaders/world/town.wgsl `Wire`). */
export const WIRE_VEC4S = 3;
const FLOATS_PER_VEC4 = 4;

export function packWires(wires: readonly Wire[]): Float32Array<ArrayBuffer> {
	const stride = WIRE_VEC4S * FLOATS_PER_VEC4;
	const packed = new Float32Array(Math.max(wires.length, 1) * stride);
	for (const [i, w] of wires.entries()) {
		packed.set(
			[
				w.a[0],
				w.a[1],
				w.heightA,
				w.siteA,
				w.b[0],
				w.b[1],
				w.heightB,
				w.siteB,
				w.sag,
				w.radius,
				0,
				0,
			],
			i * stride
		);
	}
	return packed;
}
