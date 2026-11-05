/**
 * Which building stands at a chart point: the world plan's buildings, kept
 * by island, each tested on its own footprint (its half widths about its
 * middle, turned by its turn), as the towns draw it. A click resolves to a
 * building only on the island the GPU picked there, so one test runs over
 * that island's buildings alone.
 *
 * Pure, no GPU.
 */
import type { Chart, Point } from "../../../data/chart";
import { turned } from "../world/town-parts";
import type { Building, WorldPlan } from "../world/world";

/**
 * How far past its footprint a click still names a building, chart units:
 * eaves and porches stand a little proud of the walls.
 */
const FOOTPRINT_SLOP = 0.15;

export interface BuildingIndex {
	/** The building on island `island` (its index in `chart.islands`) whose footprint holds `at`, else null. */
	at: (island: number, at: Point) => Building | null;
	byId: (id: number) => Building | undefined;
}

/** Whether a building's footprint, a little widened, holds a chart point; and how far inside it is. */
function inside(building: Building, at: Point): number | null {
	const [x, z] = turned(
		[at[0] - building.at[0], at[1] - building.at[1]],
		-building.turn
	);
	const across = building.half[0] + FOOTPRINT_SLOP - Math.abs(x);
	const deep = building.half[1] + FOOTPRINT_SLOP - Math.abs(z);
	return across >= 0 && deep >= 0 ? Math.min(across, deep) : null;
}

export function buildingIndex(chart: Chart, world: WorldPlan): BuildingIndex {
	const byId = new Map<number, Building>();
	const byIsland = new Map<string, Building[]>();
	for (const building of world.buildings) {
		byId.set(building.id, building);
		const list = byIsland.get(building.island) ?? [];
		list.push(building);
		byIsland.set(building.island, list);
	}
	return {
		at(island, at) {
			const id = chart.islands[island]?.id;
			let best: Building | null = null;
			let depth = Number.NEGATIVE_INFINITY;
			// Footprints widened by the slop can overlap a neighbour's: the one
			// the point stands deepest inside wins.
			for (const building of (id && byIsland.get(id)) || []) {
				const d = inside(building, at);
				if (d !== null && d > depth) {
					best = building;
					depth = d;
				}
			}
			return best;
		},
		byId: (id) => byId.get(id),
	};
}
