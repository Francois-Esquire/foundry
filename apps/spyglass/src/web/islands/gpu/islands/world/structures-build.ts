/**
 * The structures layer's build (WORLD.md layer 4): the world plan's
 * buildings, parcel edges and poles turned into parts of the kit
 * (town-parts.ts) placed on the chart, the sites whose ground the floors
 * pass finds, and the wires between the poles. Done once when the plan
 * changes, on the CPU; the frame only draws what this packs.
 */
import type { Point } from "../../../data/chart";
import {
	type Laid,
	partsOf,
	type Room,
	type Spot,
} from "./structures-buildings";
import { edgePieces } from "./structures-edges";
import { polesOf, type Wire } from "./structures-poles";
import { type PlacedPart, type Site, turned, variantOf } from "./town-parts";
import type { Building, WorldPlan } from "./world";

export interface BuiltStructures {
	readonly parts: readonly PlacedPart[];
	readonly sites: readonly Site[];
	readonly wires: readonly Wire[];
}

/** A pole's site: small, its ground found under its foot. */
const POLE_SITE: readonly [number, number] = [0.05, 0.05];

/** The parcel's outline in the building's frame, as its extent. */
function roomOf(
	b: Building,
	outline: readonly Point[] | undefined
): Room | null {
	if (!outline || outline.length < 3) {
		return null;
	}
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minZ = Number.POSITIVE_INFINITY;
	let maxZ = Number.NEGATIVE_INFINITY;
	for (const p of outline) {
		const [x, z] = turned([p[0] - b.at[0], p[1] - b.at[1]], -b.turn);
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minZ = Math.min(minZ, z);
		maxZ = Math.max(maxZ, z);
	}
	return { minX, maxX, minZ, maxZ };
}

/** Every structure in the plan, placed on the chart. */
export function buildStructures(plan: WorldPlan): BuiltStructures {
	const parts: PlacedPart[] = [];
	const sites: Site[] = [];
	const addSite = (site: Site): number => {
		sites.push(site);
		return sites.length - 1;
	};
	const parcels = new Map(plan.parcels.map((p) => [p.id, p]));
	for (const b of plan.buildings) {
		const room = roomOf(b, parcels.get(b.parcel)?.outline);
		const laid: Laid[] = partsOf(b, room);
		const own = addSite({ at: b.at, half: b.half, turn: b.turn });
		const spots = new Map<Spot, number>();
		const variant = variantOf(b.at);
		const place = (p: Point): Point => {
			const t = turned(p, b.turn);
			return [b.at[0] + t[0], b.at[1] + t[1]];
		};
		for (const { part, spot } of laid) {
			const at = place(part.at);
			const turn = b.turn + part.turn;
			let site = own;
			if (spot) {
				site =
					spots.get(spot) ??
					addSite({ at: place(spot.at), half: spot.half, turn: b.turn });
				spots.set(spot, site);
			} else if (part.ownSite) {
				site = addSite({ at, half: part.half, turn });
			}
			parts.push({ at, part, site, turn, variant });
		}
	}
	for (const piece of edgePieces(plan.parcels, plan.roads, plan.buildings)) {
		const site = addSite({
			at: piece.at,
			half: piece.part.half,
			turn: piece.turn,
		});
		parts.push({
			at: piece.at,
			part: piece.part,
			site,
			turn: piece.turn,
			variant: variantOf(piece.at),
		});
	}
	const { poles, wiresOf } = polesOf(plan);
	const poleSites: number[] = [];
	for (const pole of poles) {
		const site = addSite({ at: pole.at, half: POLE_SITE, turn: pole.turn });
		poleSites.push(site);
		for (const part of pole.parts) {
			const offset = turned(part.at, pole.turn);
			parts.push({
				at: [pole.at[0] + offset[0], pole.at[1] + offset[1]],
				part,
				site,
				turn: pole.turn + part.turn,
				variant: variantOf(pole.at),
			});
		}
	}
	const wires = wiresOf((k) => poleSites[k] ?? 0);
	return { parts, sites, wires };
}
