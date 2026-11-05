/**
 * The world planner (WORLD.md layer 1): `planWorld` grows each island's
 * town from its package's folders and files and returns the plan every
 * other layer draws (world.ts). It runs on the CPU when the chart changes,
 * never per frame.
 *
 * Each island is planned on its own land (town-land.ts), in its own frame:
 * the files sorted into what they are and the folder tree ordered by
 * imports (world-plan-tree.ts), the streets grown from the plaza at the
 * plateau's heart, each from its parent's, with their lots along them
 * (world-plan-grow.ts), then the town's edge: the shrine and its grove,
 * the row of boathouses on the shore, the lighthouse, the fields, the
 * gardens, the pines, the trees and the poles (world-plan-edge.ts).
 * Everything is ordered by path and drawn from hashes of paths, so the
 * same chart gives the same plan and one changed file moves only its own
 * neighbourhood.
 */
import type { Chart, Import, Module, Point } from "../../../data/chart";
import {
	CELL,
	directionToChart,
	heartOf,
	isBuildable,
	type Land,
	landOf,
	toChart,
} from "./town-land";
import type {
	Building,
	BuildingKind,
	Parcel,
	Road,
	WorldPlan,
	Zone,
} from "./world";
import { finishEdge } from "./world-plan-edge";
import { hashText, signedArea } from "./world-plan-geometry";
import {
	commitBuilding,
	commitGround,
	flatten,
	footprintOf,
	type Growth,
	groundSizeOf,
	groundSizesOf,
	growBranch,
	growRoot,
	type Leftover,
	type Mouth,
	moveMouth,
	plotAlong,
	rehouse,
} from "./world-plan-grow";
import {
	COAST_MARGIN,
	newTown,
	type RoadDraft,
	type Town,
} from "./world-plan-town";
import {
	byText,
	householdOf,
	orderStreets,
	type Sorted,
	sortIsland,
	type Unit,
} from "./world-plan-tree";

/** The steps the town's land share and its asked-for area move in (see `planIsland`). */
const SHARE_STEP = 0.05;
const DEMAND_STEP = 600;
/** The share of an island's buildable land its town may take before it builds up. */
const TOWN_SHARE = 0.4;
/** Land a lot asks for beyond its own: its share of the road and the gaps. */
const ROAD_FACTOR = 1.7;

function areaOf(ring: readonly Point[]): number {
	return Math.abs(signedArea(ring));
}

/** The land the town's units ask for, in square units. */
function demandOf(sorted: Sorted, townBuildings: number): number {
	let area = 0;
	for (const node of sorted.nodes.values()) {
		for (const item of node.units) {
			if (item.kind === "building") {
				const fp = footprintOf(item.home.kind, item.home.flats);
				area += fp.frontage * fp.depth;
			} else if (item.kind === "ground") {
				const size = groundSizeOf(item.ground.files.length, townBuildings);
				area += size.frontage * size.depth;
			}
		}
	}
	return area * ROAD_FACTOR;
}

function buildingCount(sorted: Sorted): number {
	let count = 0;
	for (const node of sorted.nodes.values()) {
		for (const item of node.units) {
			count += item.kind === "building" ? 1 : 0;
		}
	}
	return count;
}

/** The test group with the most tests, which gets the island's school. */
function schoolOf(sorted: Sorted): string | null {
	let best: { key: string; n: number } | null = null;
	for (const node of sorted.nodes.values()) {
		for (const ground of node.grounds) {
			const n = ground.files.length;
			if (
				!best ||
				n > best.n ||
				(n === best.n && byText(ground.key, best.key) < 0)
			) {
				best = { key: ground.key, n };
			}
		}
	}
	return best?.key ?? null;
}

/** Orders the streets, building up further while the town asks for more land than it has. */
function settleShare(
	sorted: Sorted,
	imports: readonly Import[],
	buildable: number
) {
	let share = 1;
	orderStreets(sorted, imports, share);
	for (let round = 0; round < 3; round += 1) {
		const demand = demandOf(sorted, buildingCount(sorted));
		if (demand <= buildable * TOWN_SHARE) {
			return demand;
		}
		// In steps, so one file more or less rarely changes every street's share.
		const next = share * Math.max(0.3, (buildable * TOWN_SHARE) / demand);
		share = Math.floor(next / SHARE_STEP) * SHARE_STEP;
		orderStreets(sorted, imports, share);
	}
	return demandOf(sorted, buildingCount(sorted));
}

// ------------------------------------------------------------ leftovers

const ANYWHERE_STEP = 1.2;
/** How many more times leftovers get new lanes while each time houses some. */
const REHOUSE_ROUNDS = 3;
/** How many of the roads nearest its own a leftover tries. */
const ANYWHERE_ROADS = 6;

/** A lot for a leftover anywhere along the town's roads, nearest its own first. */
function placeAnywhere(town: Town, left: Leftover, growth: Growth): boolean {
	const home = town.roads[left.road];
	const anchor = home?.points[0] ?? town.centre;
	const roads = [...town.roads]
		.filter((road) => road.rank !== "path")
		.sort((a, b) => nearness(a, anchor) - nearness(b, anchor))
		.slice(0, ANYWHERE_ROADS);
	const { frontage, depth } = sizeOfUnit(left.unit, growth);
	for (const road of roads) {
		const total = road.cum.at(-1) ?? 0;
		for (let s = 0.3; s + frontage < total - 0.3; s += ANYWHERE_STEP) {
			for (const side of [1, -1] as const) {
				const plot = plotAlong(town, road, s, s + frontage, side, depth, 3);
				if (plot) {
					commitUnit(town, road.id, plot, left.unit, growth);
					return true;
				}
			}
		}
	}
	return false;
}

function nearness(road: RoadDraft, p: Point): number {
	const q = road.points[Math.floor(road.points.length / 2)] ?? p;
	return Math.hypot(q[0] - p[0], q[1] - p[1]);
}

function sizeOfUnit(
	item: Unit,
	growth: Growth
): { frontage: number; depth: number } {
	if (item.kind === "building") {
		return footprintOf(item.home.kind, item.home.flats);
	}
	if (item.kind === "ground") {
		return lastResortGround(item.ground.files.length, growth);
	}
	return { frontage: 3, depth: 3 };
}

/** The smallest ground a test group makes do with, where nothing bigger fitted. */
const lastResortGround = (tests: number, growth: Growth) =>
	groundSizesOf(tests, growth.townBuildings).at(-1) ??
	groundSizeOf(tests, growth.townBuildings);

function commitUnit(
	town: Town,
	road: number,
	plot: Parameters<typeof commitBuilding>[2],
	item: Unit,
	growth: Growth
) {
	if (item.kind === "building") {
		commitBuilding(town, road, plot, item.home, item.name);
	} else if (item.kind === "ground") {
		commitGround(
			town,
			road,
			plot,
			item.ground,
			lastResortGround(item.ground.files.length, growth)
		);
	}
}

/** How many households a building's footprint can take when it has to build up. */
const ROOM_FOR: Readonly<Partial<Record<BuildingKind, number>>> = {
	house: 3,
	pair: 3,
	walkup: 8,
	block: 24,
};

/**
 * Files nothing could place move in with the homes nearest their own
 * street, a few to each, the buildings growing a floor or a kind as they
 * fill (rule 3: crowding builds up), never one building swallowing them
 * all. Test files take seats in the nearest stand.
 */
function absorb(
	town: Town,
	road: number,
	files: readonly Module[],
	seats: boolean
): boolean {
	const anchor = town.roads[road]?.points[0] ?? town.centre;
	const hosts = town.buildings
		.filter((b) => (seats ? b.kind === "stand" : (ROOM_FOR[b.kind] ?? 0) > 0))
		.map((b) => ({
			b,
			d: Math.hypot(b.at[0] - anchor[0], b.at[1] - anchor[1]),
		}))
		.sort((x, y) => x.d - y.d)
		.map(({ b }) => b);
	if (hosts.length === 0) {
		return false;
	}
	for (const m of files) {
		const host = seats
			? hosts[0]
			: hosts.find((b) => b.files.length < (ROOM_FOR[b.kind] ?? 0));
		if (!host) {
			return false;
		}
		host.files.push(m.id);
		if (!seats) {
			grownUp(host);
		}
	}
	return true;
}

/** A building's kind and floors after more households moved in. */
function grownUp(b: Town["buildings"][number]) {
	const n = b.files.length;
	if (b.kind === "house" && n > 1) {
		b.kind = "pair";
	}
	if (b.kind === "walkup") {
		b.storeys = n <= 5 ? 2 : 3;
	} else if (b.kind === "block") {
		b.storeys = Math.min(5, Math.max(3, Math.ceil(n / 5)));
	} else {
		b.storeys = 2;
	}
}

function filesOfUnit(item: Unit): Module[] {
	if (item.kind === "building") {
		return item.home.files;
	}
	return item.kind === "ground" ? item.ground.files : item.node.files;
}

// ------------------------------------------------------------ the island

/**
 * Where the town's middle goes: deep enough inside the coast for the town
 * to spread round it, as near the middle of the buildable land as that
 * allows.
 */
function middleOf(land: Land, radius: number): Point {
	let su = 0;
	let sv = 0;
	let n = 0;
	for (let j = 0; j < land.rows; j += 1) {
		for (let i = 0; i < land.cols; i += 1) {
			if ((land.clear[j * land.cols + i] ?? 0) >= land.margin) {
				su += i;
				sv += j;
				n += 1;
			}
		}
	}
	if (n === 0) {
		return heartOf(land);
	}
	const mi = su / n;
	const mj = sv / n;
	const deep = (land.margin + radius * 0.45) / CELL;
	let best = 0;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (let j = 0; j < land.rows; j += 1) {
		for (let i = 0; i < land.cols; i += 1) {
			const cell = j * land.cols + i;
			const clear = (land.clear[cell] ?? 0) / CELL;
			if (clear < land.margin / CELL) {
				continue;
			}
			const score =
				Math.min(clear, deep) -
				0.6 * Math.sqrt((i - mi) * (i - mi) + (j - mj) * (j - mj));
			if (score > bestScore) {
				bestScore = score;
				best = cell;
			}
		}
	}
	return [
		land.u0 + ((best % land.cols) + 0.5) * CELL,
		land.v0 + (Math.floor(best / land.cols) + 0.5) * CELL,
	];
}

interface IslandResult {
	/** Files no building could hold (only when the island has no land at all). */
	readonly lost: readonly Module[];
	readonly town: Town;
}

function planIsland(
	chart: Chart,
	island: string,
	files: readonly Module[],
	imports: readonly Import[]
): IslandResult | null {
	const coast = chart.islands.find((i) => i.id === island)?.shape.coast ?? [];
	const [largest] = [...coast].sort(
		(a, b) => areaOf(b.outer) - areaOf(a.outer)
	);
	if (!largest || files.length === 0) {
		return null;
	}
	const land = landOf(largest, COAST_MARGIN);
	let buildableCells = 0;
	for (let cell = 0; cell < land.clear.length; cell += 1) {
		buildableCells += isBuildable(land, cell) ? 1 : 0;
	}
	const sorted = sortIsland(files, imports);
	const demand = settleShare(sorted, imports, buildableCells * CELL * CELL);
	const town = newTown(island, land, imports, hashText(island));
	// The town's reach steers every street, so it moves in steps: a file
	// more or less leaves it, and everything grown by it, where it was.
	const stepped = Math.ceil(Math.max(demand, 50) / DEMAND_STEP) * DEMAND_STEP;
	town.radius = Math.sqrt(stepped / Math.PI);
	town.centre = middleOf(land, town.radius);
	const growth: Growth = {
		leftovers: [],
		mouths: [],
		school: schoolOf(sorted),
		townBuildings: buildingCount(sorted),
	};
	const station = sorted.station
		? householdOf("station", [sorted.station])
		: null;
	const root = growRoot(town, sorted.top, station, growth);
	growFrom(town, root.id, growth);
	const lost = settleLeftovers(town, growth);
	finishEdge(town, largest, sorted.alone, lost);
	return { town, lost };
}

/**
 * What the streets could not hold: new lanes for it while each round
 * houses some, then any free frontage, then the homes nearest its street.
 * Returns files not even that could take (an island with no town at all).
 */
function settleLeftovers(town: Town, growth: Growth): Module[] {
	let left = rehouse(town, growth);
	for (let round = 0; round < REHOUSE_ROUNDS && left.length > 0; round += 1) {
		const before = left.length;
		growth.leftovers.push(...left);
		left = rehouse(town, growth);
		if (left.length >= before) {
			break;
		}
	}
	// Broken into pairs, they get one more round of lanes of their own.
	growth.leftovers.push(...left.flatMap(piecesOf));
	left = rehouse(town, growth);
	const lost: Module[] = [];
	for (const item of left) {
		if (placeAnywhere(town, item, growth)) {
			continue;
		}
		const files = filesOfUnit(item.unit);
		if (!absorb(town, item.road, files, item.unit.kind === "ground")) {
			lost.push(...files);
		}
	}
	return lost;
}

/**
 * A building that found no room whole tries again as pairs, which fit
 * where a block or a walk-up can't; anything else stays as it is.
 */
function piecesOf(item: Leftover): Leftover[] {
	if (item.unit.kind !== "building" || item.unit.home.files.length <= PIECE) {
		return [item];
	}
	const { files } = item.unit.home;
	const out: Leftover[] = [];
	for (let k = 0; k < files.length; k += PIECE) {
		const share = files.slice(k, k + PIECE);
		const home = householdOf(share.length > 1 ? "pair" : "house", share);
		out.push({
			road: item.road,
			unit: { kind: "building", name: share[0]?.id ?? item.unit.name, home },
		});
	}
	return out;
}

/** Households a piece of a broken-up building holds: a pair's worth. */
const PIECE = 3;

/** Grows every branch of a road, each one's own branches before the next: depth first. */
function growFrom(town: Town, road: number, growth: Growth) {
	const mine = growth.mouths.filter((m) => m.owner === road);
	for (const mouth of mine) {
		growSubtree(town, mouth, growth);
	}
}

/** Grows one branch and everything below it, moving its mouth once if it can't grow. */
function growSubtree(town: Town, mouth: Mouth, growth: Growth) {
	let road = growBranch(town, mouth, growth);
	if (!road) {
		const moved = moveMouth(town, mouth, growth);
		road = moved ? growBranch(town, moved, growth) : null;
	}
	if (!road) {
		for (const item of flatten(mouth.node)) {
			growth.leftovers.push({ road: mouth.road, unit: item });
		}
		return;
	}
	growFrom(town, road.id, growth);
}

// ------------------------------------------------------------- the result

/** One island's town into the world's plan, in chart units and global ids. */
function publish(result: IslandResult, out: Mutable) {
	const { town } = result;
	const { land } = town;
	const roadIds = new Map<number, number>();
	for (const road of town.roads) {
		if (road.points.length < 2) {
			continue;
		}
		roadIds.set(road.id, out.roads.length);
		out.roads.push({
			id: out.roads.length,
			island: town.island,
			folder: road.folder,
			rank: road.rank,
			width: road.width,
			points: road.points.map(([u, v]) => toChart(land, u, v)),
		});
	}
	const parcelIds = new Map<number, number>();
	for (const parcel of town.parcels) {
		if (!parcel.alive || parcel.kind === "reserve") {
			continue;
		}
		parcelIds.set(parcel.id, out.parcels.length);
		out.parcels.push({
			id: out.parcels.length,
			island: town.island,
			kind: parcel.kind,
			outline: parcel.outline.map(([u, v]) => toChart(land, u, v)),
			road: parcel.road === null ? null : (roadIds.get(parcel.road) ?? null),
			edge: parcel.edge,
		});
	}
	for (const b of town.buildings) {
		const [fx, fy] = directionToChart(land, b.face[0], b.face[1]);
		const id = out.buildings.length;
		out.buildings.push({
			id,
			island: town.island,
			parcel: parcelIds.get(b.parcel) ?? -1,
			kind: b.kind,
			at: toChart(land, b.at[0], b.at[1]),
			turn: Math.atan2(-fx, fy),
			half: [b.half[0], b.half[1]],
			storeys: b.storeys,
			files: [...b.files],
		});
		for (const file of b.files) {
			out.buildingOf.set(file, id);
		}
	}
	for (const zone of town.zones) {
		out.zones.push({
			island: town.island,
			kind: zone.kind,
			outline: zone.outline.map(([u, v]) => toChart(land, u, v)),
		});
	}
	for (const tree of town.trees) {
		out.trees.push({ ...tree, at: toChart(land, tree.at[0], tree.at[1]) });
	}
	for (const pole of town.poles) {
		const road = roadIds.get(pole.road);
		if (road !== undefined) {
			out.poles.push({ at: toChart(land, pole.at[0], pole.at[1]), road });
		}
	}
}

interface Mutable {
	readonly buildingOf: Map<string, number>;
	readonly buildings: Building[];
	readonly parcels: Parcel[];
	readonly poles: { at: Point; road: number }[];
	readonly roads: Road[];
	readonly trees: WorldPlan["trees"][number][];
	readonly zones: Zone[];
}

/**
 * The world's plan: every island's town grown on its land. Deterministic:
 * the same chart gives the same plan.
 */
export function planWorld(chart: Chart): WorldPlan {
	const byIsland = new Map<string, Module[]>();
	for (const m of chart.modules) {
		const list = byIsland.get(m.island) ?? [];
		list.push(m);
		byIsland.set(m.island, list);
	}
	const islandOf = new Map(chart.modules.map((m) => [m.id, m.island] as const));
	const importsOf = new Map<string, Import[]>();
	for (const imp of chart.imports) {
		const island = islandOf.get(imp.from);
		if (
			!imp.crossing &&
			island !== undefined &&
			islandOf.get(imp.to) === island
		) {
			const list = importsOf.get(island) ?? [];
			list.push(imp);
			importsOf.set(island, list);
		}
	}
	const out: Mutable = {
		roads: [],
		parcels: [],
		buildings: [],
		zones: [],
		trees: [],
		poles: [],
		buildingOf: new Map(),
	};
	for (const island of [...byIsland.keys()].sort(byText)) {
		const result = planIsland(
			chart,
			island,
			byIsland.get(island) ?? [],
			importsOf.get(island) ?? []
		);
		if (result) {
			publish(result, out);
		}
	}
	return out;
}
